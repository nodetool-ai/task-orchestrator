#!/usr/bin/env python3
"""Linux cgroup-v2 containment for a worker and its shell tool invocations.

  python3 process-supervisor.py worker --instance <instanceId> -- node worker.js
  python3 process-supervisor.py command --timeout-seconds 120 -- bash -lc '...'

The worker exports its containment/lock paths to every SDK and nested agent.
An aggregate cgroup bounds *all* processes, independently of their executable
names. Every command additionally holds one flock permit until its entire
subtree has been killed and reaped. This is resource containment, not a security
boundary against a malicious workload with sudo access.
"""

import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


CGROUP_ROOT = Path("/sys/fs/cgroup/task-orchestrator")
POLL_SECONDS = 0.05
TERM_SECONDS = 2.0
KILL_SECONDS = 3.0
MAX_COMMAND_SECONDS = 1800
EX_CONFIG = 78
EX_CLEANUP = 74
MAX_ENTRY_BYTES = 1024 * 1024


class ContainmentError(RuntimeError):
    pass


def log(message):
    print("[process-supervisor] " + message, file=sys.stderr, flush=True)


def read(path):
    return Path(path).read_text().strip()


def write(path, value):
    # One write matters for cgroup.procs, which accepts one process per write.
    with open(path, "w") as handle:
        handle.write(str(value))


def positive_integer(value):
    value = int(value)
    if value <= 0:
        raise ValueError("must be greater than zero")
    return value


def resource_limits(environ=None, memory_bytes=None):
    environ = os.environ if environ is None else environ
    if memory_bytes is None:
        memory_bytes = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    memory = positive_integer(environ.get(
        "TASK_ORCH_PROCESS_MEMORY_MAX_BYTES", min(6 * 1024**3, memory_bytes * 3 // 4)))
    swap = int(environ.get("TASK_ORCH_PROCESS_SWAP_MAX_BYTES", 256 * 1024**2))
    pids = positive_integer(environ.get("TASK_ORCH_PROCESS_PIDS_MAX", 256))
    if swap < 0:
        raise ValueError("swap limit must be nonnegative")
    return memory, swap, pids


def command_memory_limit(worker_memory):
    """Leave runtime headroom; compiler OOM should fail its tool, not the run."""
    worker_memory = positive_integer(worker_memory)
    reserve = min(1024**3, worker_memory // 4)
    return worker_memory - reserve


def validate_instance(instance):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", instance):
        raise ContainmentError("instance must be a safe, fresh channel instanceId")
    return instance


def enable_controllers(path):
    available = set(read(path / "cgroup.controllers").split())
    if not {"memory", "pids"}.issubset(available):
        raise ContainmentError("cgroup v2 memory and pids controllers are required at " + str(path))
    enabled = set(read(path / "cgroup.subtree_control").split())
    missing = {"memory", "pids"} - enabled
    if missing:
        write(path / "cgroup.subtree_control", " ".join("+" + item for item in sorted(missing)))


def delegate_directory(path, uid, gid):
    os.chown(path, uid, gid)
    for name in ("cgroup.procs", "cgroup.threads", "cgroup.subtree_control", "cgroup.kill"):
        target = path / name
        if target.exists():
            os.chown(target, uid, gid)


def namespace_budget(limits=None):
    """A Sprite's populated namespace root owns the aggregate controllers.

    Keep provider init/exec tasks where the provider put them. Core child
    cgroups still support cgroup.kill without delegated memory controllers.
    This mode is explicit, and never applies to the host hierarchy root.
    """
    mount = Path("/sys/fs/cgroup")
    if (read("/proc/1/cgroup") != "0::/"
            or 1 not in {int(pid) for pid in read(mount / "cgroup.procs").split()}
            or read("/proc/1/comm") not in {"tini", "docker-init"}
            or not (mount / "memory.max").exists()
            or read(mount / "cgroup.subtree_control")):
        raise ContainmentError("namespace budget requires an isolated, populated container cgroup root")
    if read(mount / "memory.oom.group") != "0":
        raise ContainmentError("namespace budget must not group-kill the provider init process")
    for name, requested in zip(("memory.max", "memory.swap.max", "pids.max"), limits or (None,) * 3):
        current = read(mount / name)
        if requested is not None:
            # Never loosen a provider/operator limit, including on a restart.
            bound = requested if current == "max" else min(int(current), requested)
            write(mount / name, bound)
            current = read(mount / name)
        if current == "max" or int(current) < (0 if name == "memory.swap.max" else 1):
            raise ContainmentError("namespace workload requires a finite " + name)
    return mount


def prepare_cgroup(root, instance, uid, gid, limits, namespace_root=False):
    """Provision empty internal nodes; never migrate unrelated host processes."""
    root = root.absolute()
    # Resolve existing ancestors before creating anything; do not follow an
    # operator-supplied symlink outside the cgroup mount during root setup.
    if not str(root).startswith("/sys/fs/cgroup/") or root.resolve() != root:
        raise ContainmentError("cgroup root must be a real directory below /sys/fs/cgroup")
    validate_instance(instance)
    if namespace_root:
        if root.parent != Path("/sys/fs/cgroup"):
            raise ContainmentError("namespace containment must be directly below /sys/fs/cgroup")
        namespace_budget(limits)
    else:
        enable_controllers(root.parent)
    root.mkdir(exist_ok=True)
    if not namespace_root:
        enable_controllers(root)
    owner = root / ("u" + str(uid))
    owner.mkdir(exist_ok=True)
    if not namespace_root:
        enable_controllers(owner)
    delegate_directory(owner, uid, gid)
    scope = owner / instance
    # Existing scopes may contain retained work from a prior process. Never
    # adopt, empty, or kill them: each service launch needs a new incarnation.
    scope.mkdir()
    try:
        if not namespace_root:
            memory, swap, pids = limits
            write(scope / "memory.max", memory)
            write(scope / "memory.swap.max", swap)
            write(scope / "pids.max", pids)
            write(scope / "memory.oom.group", 1)
        if not (scope / "cgroup.kill").exists():
            raise ContainmentError("Linux cgroup.kill support is required (Linux 5.14+)")
        if not namespace_root:
            enable_controllers(scope)
        runtime = scope / "runtime"
        runtime.mkdir()
        delegate_directory(runtime, uid, gid)
        delegate_directory(scope, uid, gid)
    except BaseException:
        remove_empty_scope(scope)
        raise
    return scope


def create_worker_scope(args):
    limits = resource_limits()
    root = args.cgroup_root
    if os.geteuid() == 0:
        return prepare_cgroup(root, args.instance, os.getuid(), os.getgid(), limits, args.namespace_root)
    # Provisioning and the initial cross-delegation migration need privilege.
    # The worker and both supervisors retain their ordinary user identity.
    command = ["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "prepare",
               "--cgroup-root", str(root), "--instance", args.instance,
               "--uid", str(os.getuid()), "--gid", str(os.getgid()),
               "--memory", str(limits[0]), "--swap", str(limits[1]), "--pids", str(limits[2])]
    if args.namespace_root:
        command.append("--namespace-root")
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ContainmentError("cannot provision cgroup: passwordless sudo and Python 3 are required") from exc
    if result.returncode:
        # This subprocess only handles explicit resource numbers and paths; it
        # never queries/prints service environment or credentials.
        raise ContainmentError("cgroup provisioning failed: " + result.stderr[-2000:].strip())
    return root / ("u" + str(os.getuid())) / args.instance


def worker_entry_payload(command, environ):
    """Anonymous stdin carries credentials without argv exposure or disk I/O."""
    payload = json.dumps({"command": command, "environ": environ}).encode()
    if len(payload) > MAX_ENTRY_BYTES:
        raise ContainmentError("worker launch configuration exceeds its bounded transfer size")
    fd = os.memfd_create("task-orch-worker-entry", os.MFD_CLOEXEC)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(fd, payload[offset:])
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def enter_worker_scope(scope, uid, gid):
    """Root moves only itself, drops privilege, then execs the ordinary worker.

    Cgroup-v2 migration requires permission on the common ancestor's procs
    file. A service starts outside our delegated tree, so chowning only its
    destination is insufficient. Never chmod the host's root cgroup.procs or
    attach another numeric PID (which could be recycled after a check).
    """
    if os.geteuid() != 0 or uid < 0 or gid < 0:
        raise ContainmentError("worker entry requires privileged migration and a valid target identity")
    if os.environ.get("SUDO_UID") != str(uid) or os.environ.get("SUDO_GID") != str(gid):
        raise ContainmentError("worker entry identity does not match the invoking service user")
    scope = scope.absolute()
    if (not str(scope).startswith("/sys/fs/cgroup/") or scope.resolve() != scope
            or scope.parent.name != "u" + str(uid) or scope.stat().st_uid != uid):
        raise ContainmentError("worker entry requires its user's already provisioned cgroup")
    validate_instance(scope.name)
    leaf = scope / "runtime"
    if leaf.stat().st_uid != uid or not (scope / "cgroup.kill").exists():
        raise ContainmentError("worker runtime cgroup is not delegated to the service user")
    payload = sys.stdin.buffer.read(MAX_ENTRY_BYTES + 1)
    if len(payload) > MAX_ENTRY_BYTES:
        raise ContainmentError("worker entry configuration exceeds its size bound")
    configuration = json.loads(payload)
    command = configuration.get("command")
    environ = configuration.get("environ")
    if (not isinstance(command, list) or not command or not all(isinstance(v, str) for v in command)
            or not isinstance(environ, dict)
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in environ.items())):
        raise ContainmentError("invalid worker entry configuration")
    parent = os.getppid()
    prctl(1, signal.SIGKILL)
    # PID 0 means the writing task itself, making identity reuse impossible.
    write(leaf / "cgroup.procs", 0)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    # Credential changes clear PDEATHSIG; restore after dropping privilege.
    prctl(1, signal.SIGKILL)
    if os.getppid() != parent:
        os._exit(128 + signal.SIGKILL)
    with open(os.devnull, "rb") as handle:
        os.dup2(handle.fileno(), 0)
    os.execvpe(command[0], command, environ)


def inherited_scope(environ=None):
    environ = os.environ if environ is None else environ
    value = environ.get("TASK_ORCH_PROCESS_CGROUP", "")
    path = Path(value)
    if not value or not path.is_absolute() or not str(path).startswith("/sys/fs/cgroup/"):
        raise ContainmentError("command requires TASK_ORCH_PROCESS_CGROUP from the worker supervisor")
    if path.resolve() != path or not (path / "cgroup.kill").exists():
        raise ContainmentError("worker containment scope is missing or invalid")
    return path


class StopState:
    def __init__(self):
        self.signal = 0

    def receive(self, number, _frame):
        self.signal = self.signal or number


def prctl(option, value):
    library = ctypes.CDLL(None, use_errno=True)
    if library.prctl(option, value, 0, 0, 0) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def configure_supervisor(expected_parent):
    state = StopState()
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, state.receive)
    prctl(36, 1)  # PR_SET_CHILD_SUBREAPER: adopts setsid/double-fork descendants.
    prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG, also covers parent SIGKILL.
    if os.getppid() != expected_parent:
        state.signal = signal.SIGTERM  # Close the fork/prctl parent-death race.
    return state


def acquire_permit(path, state, deadline, now=time.time, sleep=time.sleep):
    """Flock ownership survives only while either supervisor is still alive."""
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        while not state.signal:
            if now() >= deadline:
                raise TimeoutError("command timed out while waiting for the shared execution permit")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                sleep(POLL_SECONDS)
        raise InterruptedError("command cancelled while waiting for the shared execution permit")
    except BaseException:
        os.close(fd)
        raise


def scope_populated(scope):
    try:
        fields = dict(line.split() for line in read(scope / "cgroup.events").splitlines())
        return fields.get("populated") == "1"
    except FileNotFoundError:
        return False


def scope_pids(scope):
    paths = [scope / "cgroup.procs", *scope.glob("**/cgroup.procs")]
    for path in set(paths):
        try:
            for value in read(path).splitlines():
                yield int(value)
        except FileNotFoundError:
            continue


def signal_scope(scope, number):
    """Use pidfds plus a membership recheck; never signal a recycled PID."""
    for pid in set(scope_pids(scope)):
        try:
            fd = os.pidfd_open(pid)
        except (ProcessLookupError, PermissionError):
            continue
        try:
            # Opening a pidfd pins identity, but that PID may already have been
            # reused between listing and opening. Recheck scoped membership.
            if pid in set(scope_pids(scope)):
                signal.pidfd_send_signal(fd, number)
        except (ProcessLookupError, PermissionError):
            # Initial root entry can be observed just before it drops UID.
            # Best-effort TERM must never bypass the owned cgroup.kill fence.
            pass
        finally:
            os.close(fd)


def reap_children(results):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        if pid == 0:
            return True
        results[pid] = os.waitstatus_to_exitcode(status)


def kill_scope(scope):
    try:
        # Atomic kernel subtree termination also catches concurrent forks and
        # descendants that changed sessions/process groups.
        write(scope / "cgroup.kill", 1)
    except FileNotFoundError:
        pass


def clean_scope(scope, results, grace=TERM_SECONDS, now=time.time, sleep=time.sleep):
    if scope_populated(scope):
        signal_scope(scope, signal.SIGTERM)
    deadline = now() + grace
    while scope_populated(scope) and now() < deadline:
        reap_children(results)
        sleep(POLL_SECONDS)
    kill_scope(scope)
    deadline = now() + KILL_SECONDS
    while now() < deadline:
        children = reap_children(results)
        if not scope_populated(scope) and not children:
            return True
        sleep(POLL_SECONDS)
    # D-state tasks cannot be forced out of a stuck kernel syscall. Preserve
    # the scope and report failure; never report successful orphan cleanup.
    if scope_populated(scope):
        log("cgroup remains populated after SIGKILL; kernel-uninterruptible tasks may require VM recovery")
        return False
    return not reap_children(results)


def remove_empty_scope(scope):
    if not scope.exists() or scope_populated(scope):
        return
    for path in sorted((p for p in scope.glob("**/*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir()
        except FileNotFoundError:
            pass
    scope.rmdir()


def normalized_exit(code):
    return 128 - code if code < 0 else code


def supervise_workload(scope, leaf, command, environ, deadline, expected_parent):
    state = configure_supervisor(expected_parent)
    results = {}
    if state.signal:
        return 128 + state.signal
    # The first worker launch crosses from the service's parent cgroup into
    # our delegation. Later command launches move between owned sibling leaves
    # and need no sudo. The root helper migrates itself, then sheds privilege.
    entry_fd = worker_entry_payload(command, environ) if leaf != scope and os.geteuid() != 0 else None
    parent = os.getpid()
    pid = os.fork()
    if pid == 0:
        try:
            prctl(1, signal.SIGKILL)
            if os.getppid() != parent:
                os._exit(128 + signal.SIGKILL)
            for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGPIPE):
                signal.signal(number, signal.SIG_DFL)
            if entry_fd is not None:
                os.dup2(entry_fd, 0)
                os.close(entry_fd)
                os.execvp("sudo", ["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "enter",
                                   "--scope", str(scope), "--uid", str(os.getuid()), "--gid", str(os.getgid())])
            write(leaf / "cgroup.procs", os.getpid())
            os.execvpe(command[0], command, environ)
        except BaseException as exc:
            log("cannot start contained workload: " + str(exc))
            os._exit(EX_CONFIG)
    if entry_fd is not None:
        os.close(entry_fd)
    reason = None
    while pid not in results:
        reap_children(results)
        if state.signal:
            reason = 128 + state.signal
            break
        if time.time() >= deadline:
            log("command exceeded its wall-clock timeout")
            reason = 124
            break
        if pid not in results:
            time.sleep(POLL_SECONDS)
    code = reason if reason is not None else normalized_exit(results[pid])
    if not clean_scope(scope, results):
        return EX_CLEANUP
    return code


def run_guarded(scope, leaf, command, environ, deadline, outer_state):
    """Two supervisors survive loss of either one; neither enters the target.

    The inner adopts/reaps workload descendants. If it dies, the outer adopts
    them and cleans the scope. If the outer dies, PR_SET_PDEATHSIG makes the
    inner clean up. SIGKILL of an invocation wrapper cannot strand its tools.
    """
    parent = os.getpid()
    guardian = os.fork()
    if guardian == 0:
        try:
            code = supervise_workload(scope, leaf, command, environ, deadline, parent)
            remove_empty_scope(scope)
        except BaseException as exc:
            log("inner supervisor failed: " + str(exc))
            # The surviving outer performs fenced cleanup and reaping.
            code = EX_CLEANUP
        os._exit(code)
    results = {}
    stop_deadline = float("inf")
    stop_code = None
    while guardian not in results:
        reap_children(results)
        if guardian in results:
            break
        if (outer_state.signal or time.time() >= deadline) and stop_deadline == float("inf"):
            stop_code = 128 + outer_state.signal if outer_state.signal else 124
            os.kill(guardian, signal.SIGTERM)  # Child identity cannot be reused before waitpid.
            stop_deadline = time.time() + TERM_SECONDS + KILL_SECONDS + 1
        if time.time() >= stop_deadline:
            kill_scope(scope)
            os.kill(guardian, signal.SIGKILL)
            break
        time.sleep(POLL_SECONDS)
    if not clean_scope(scope, results, grace=0):
        return EX_CLEANUP
    remove_empty_scope(scope)
    return stop_code if stop_code is not None else normalized_exit(results.get(guardian, EX_CLEANUP))


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    subcommands = result.add_subparsers(dest="mode", required=True)
    for mode in ("worker", "prepare"):
        subparser = subcommands.add_parser(mode)
        subparser.add_argument("--instance", required=True, type=validate_instance)
        subparser.add_argument("--cgroup-root", type=Path, default=CGROUP_ROOT)
        subparser.add_argument("--namespace-root", action="store_true",
                               default=os.environ.get("TASK_ORCH_PROCESS_NAMESPACE_ROOT") == "1",
                               help="bound an isolated Sprite/container at its populated cgroup namespace root")
        if mode == "prepare":
            for name in ("uid", "gid", "memory", "swap", "pids"):
                subparser.add_argument("--" + name, type=int, required=True)
        else:
            subparser.add_argument("command", nargs=argparse.REMAINDER)
    subparser = subcommands.add_parser("command")
    subparser.add_argument("--timeout-seconds", type=positive_integer, default=120)
    subparser.add_argument("command", nargs=argparse.REMAINDER)
    subparser = subcommands.add_parser("enter")
    subparser.add_argument("--scope", type=Path, required=True)
    subparser.add_argument("--uid", type=int, required=True)
    subparser.add_argument("--gid", type=int, required=True)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ContainmentError("requires Linux cgroup v2, pidfds, and Python 3.9+; refusing an unbounded workload")
    if args.mode == "enter":
        enter_worker_scope(args.scope, args.uid, args.gid)
        return EX_CONFIG  # Successful entry execs and never returns.
    if args.mode == "prepare":
        if args.uid < 0 or args.gid < 0 or args.memory <= 0 or args.swap < 0 or args.pids <= 0:
            raise ContainmentError("invalid cgroup ownership or limits")
        prepare_cgroup(args.cgroup_root, args.instance, args.uid, args.gid, (args.memory, args.swap, args.pids), args.namespace_root)
        return 0
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ContainmentError("a command after -- is required")
    state = configure_supervisor(os.getppid())
    if state.signal:
        return 128 + state.signal
    lock_fd = None
    lock_dir = None
    scope = None
    try:
        environ = dict(os.environ)
        if args.mode == "worker":
            scope = create_worker_scope(args)
            leaf = scope / "runtime"
            lock_dir = tempfile.mkdtemp(prefix="task-orch-process-")
            environ.update(TASK_ORCH_PROCESS_CGROUP=str(scope),
                           TASK_ORCH_PROCESS_LOCK=str(Path(lock_dir) / "command.lock"),
                           TASK_ORCH_PROCESS_NAMESPACE_ROOT="1" if args.namespace_root else "0",
                           TASK_ORCH_PROCESS_SUPERVISOR=str(Path(__file__).resolve()))
            deadline = float("inf")
        else:
            if args.timeout_seconds > MAX_COMMAND_SECONDS:
                raise ContainmentError("command timeout must not exceed " + str(MAX_COMMAND_SECONDS) + " seconds")
            parent_scope = inherited_scope()
            lock_path = environ.get("TASK_ORCH_PROCESS_LOCK")
            if not lock_path or not Path(lock_path).is_absolute():
                raise ContainmentError("command requires TASK_ORCH_PROCESS_LOCK from the worker supervisor")
            deadline = time.time() + args.timeout_seconds
            lock_fd = acquire_permit(lock_path, state, deadline)
            scope = parent_scope / ("command-" + uuid.uuid4().hex)
            scope.mkdir()
            if environ.get("TASK_ORCH_PROCESS_NAMESPACE_ROOT") == "1":
                namespace_budget()  # Recheck the aggregate backstop before every tool.
            else:
                write(scope / "memory.max", command_memory_limit(read(parent_scope / "memory.max")))
                write(scope / "memory.oom.group", 1)
            leaf = scope
        if state.signal:
            return 128 + state.signal
        return run_guarded(scope, leaf, command, environ, deadline, state)
    except TimeoutError as exc:
        log(str(exc))
        return 124
    except InterruptedError:
        return 128 + (state.signal or signal.SIGTERM)
    finally:
        if scope is not None:
            remove_empty_scope(scope)
        if lock_fd is not None:
            os.close(lock_fd)
        if lock_dir is not None and (scope is None or not scope_populated(scope)):
            shutil.rmtree(lock_dir)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ContainmentError, OSError, ValueError) as error:
        log(str(error) + "; verify writable cgroup v2 memory/pids delegation and noninteractive sudo before restarting the worker")
        sys.exit(EX_CONFIG)
