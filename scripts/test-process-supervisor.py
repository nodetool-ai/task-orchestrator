#!/usr/bin/env python3
"""Run portable tests with `python3 scripts/test-process-supervisor.py`.

Linux integration requires an explicitly authorized, writable cgroup-v2
delegation, including memory/pids and cgroup.kill (root inside an isolated test
VM/container also works). It never uses a production service or Sprite:

  TASK_ORCH_TEST_CGROUP_ROOT=/sys/fs/cgroup/task-orch-tests \
    python3 scripts/test-process-supervisor.py

Use a cgroup-v2 VM or a disposable privileged container with its own writable
cgroup mount. A normal Docker container's read-only cgroup mount is unsuitable.
"""

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("process-supervisor.py")
SPEC = importlib.util.spec_from_file_location("process_supervisor", SCRIPT)
SUPERVISOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPERVISOR)
LINUX_ROOT = os.environ.get("TASK_ORCH_TEST_CGROUP_ROOT")
NAMESPACE_ROOT = os.environ.get("TASK_ORCH_PROCESS_NAMESPACE_ROOT") == "1"


class SupervisorUnitTests(unittest.TestCase):
    def test_namespace_budget_rejects_a_host_root_before_writing_limits(self):
        with mock.patch.object(SUPERVISOR, "read", return_value="0::/system.slice/init.scope"), mock.patch.object(SUPERVISOR, "write") as write:
            with self.assertRaisesRegex(SUPERVISOR.ContainmentError, "isolated"):
                SUPERVISOR.namespace_budget((100, 0, 4))
            write.assert_not_called()

    def test_namespace_budget_never_relaxes_existing_provider_limits(self):
        values = {"/proc/1/cgroup": "0::/", "/proc/1/comm": "tini",
                  "cgroup.procs": "1\n3", "cgroup.subtree_control": "", "memory.oom.group": "0",
                  "memory.max": "50", "memory.swap.max": "0", "pids.max": "8"}
        def get(path):
            return values.get(str(path), values.get(Path(path).name))
        with mock.patch.object(SUPERVISOR, "read", side_effect=get), mock.patch.object(SUPERVISOR.Path, "exists", return_value=True), mock.patch.object(SUPERVISOR, "write") as write:
            SUPERVISOR.namespace_budget((100, 10, 16))
            self.assertEqual([call.args[1] for call in write.call_args_list], [50, 0, 8])
            values["memory.max"] = "max"
            with self.assertRaisesRegex(SUPERVISOR.ContainmentError, "finite memory.max"):
                SUPERVISOR.namespace_budget()

    def test_worker_reserves_ram_and_bounds_swap_and_forks(self):
        self.assertEqual(SUPERVISOR.resource_limits({}, 8 * 1024**3), (6 * 1024**3, 256 * 1024**2, 256))
        self.assertEqual(SUPERVISOR.resource_limits({}, 2 * 1024**3)[0], int(1.5 * 1024**3))
        self.assertEqual(SUPERVISOR.resource_limits({}, 64 * 1024**3)[0], 6 * 1024**3)

    def test_invalid_resource_overrides_fail_closed(self):
        for key, value in (("MEMORY_MAX_BYTES", "0"), ("SWAP_MAX_BYTES", "-1"), ("PIDS_MAX", "max")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                SUPERVISOR.resource_limits({"TASK_ORCH_PROCESS_" + key: value}, 8 * 1024**3)
        self.assertEqual(SUPERVISOR.resource_limits({"TASK_ORCH_PROCESS_SWAP_MAX_BYTES": "0"}, 8 * 1024**3)[1], 0)

    def test_command_memory_reserves_runtime_headroom(self):
        self.assertEqual(SUPERVISOR.command_memory_limit(6 * 1024**3), 5 * 1024**3)
        self.assertEqual(SUPERVISOR.command_memory_limit(512 * 1024**2), 384 * 1024**2)
        with self.assertRaises(ValueError):
            SUPERVISOR.command_memory_limit("max")

    def test_privileged_entry_rejects_an_unrelated_user_before_migration(self):
        with mock.patch.object(SUPERVISOR.os, "geteuid", return_value=0), mock.patch.dict(SUPERVISOR.os.environ, {"SUDO_UID": "1001", "SUDO_GID": "1001"}), mock.patch.object(SUPERVISOR, "write") as write:
            with self.assertRaisesRegex(SUPERVISOR.ContainmentError, "does not match"):
                SUPERVISOR.enter_worker_scope(Path("/sys/fs/cgroup/task-orchestrator/u1000/instance"), 1000, 1000)
            write.assert_not_called()

    def test_instance_cannot_escape_or_reuse_parent_directory(self):
        for value in ("", ".", "..", "../../init.scope", "instance/child", "x" * 129, "a\n"):
            with self.subTest(value=value), self.assertRaises(SUPERVISOR.ContainmentError):
                SUPERVISOR.validate_instance(value)
        self.assertEqual(SUPERVISOR.validate_instance("worker-abc_1.2"), "worker-abc_1.2")

    def test_unsupported_host_never_executes_unbounded(self):
        with mock.patch.object(SUPERVISOR.sys, "platform", "darwin"), mock.patch.object(SUPERVISOR, "run_guarded") as spawn:
            with self.assertRaisesRegex(SUPERVISOR.ContainmentError, "refusing an unbounded"):
                SUPERVISOR.main(["worker", "--instance", "fresh", "--", "echo", "should-not-run"])
            spawn.assert_not_called()

    def test_inherited_scope_must_be_real_cgroup(self):
        for value in ("", "relative", "/tmp/unbounded", "/sys/fs/cgroup/nonexistent-test-scope"):
            with self.subTest(value=value), self.assertRaises(SUPERVISOR.ContainmentError):
                SUPERVISOR.inherited_scope({"TASK_ORCH_PROCESS_CGROUP": value})

    def test_failed_privileged_provisioning_never_starts_workload(self):
        args = SUPERVISOR.parser().parse_args(["worker", "--instance", "fresh", "--", "true"])
        with mock.patch.object(SUPERVISOR.os, "geteuid", return_value=1000), mock.patch.object(SUPERVISOR, "resource_limits", return_value=(100, 0, 4)), mock.patch.object(SUPERVISOR.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "memory controller unavailable")):
            with self.assertRaisesRegex(SUPERVISOR.ContainmentError, "memory controller unavailable"):
                SUPERVISOR.create_worker_scope(args)

    def test_permit_serializes_independent_open_file_descriptions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "permit"
            first = SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), time.time() + 1)
            try:
                with self.assertRaises(TimeoutError):
                    SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), time.time() + 0.1)
            finally:
                os.close(first)
            second = SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), time.time() + 1)
            self.assertFalse(os.get_inheritable(second))
            os.close(second)

    def test_waiting_permit_catches_up_after_wall_clock_jump(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "permit"
            first = SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), time.time() + 1)
            try:
                # The VM resumes ten minutes later while monotonic sleeps have
                # barely advanced. The queued invocation must never start.
                clock = iter((100.0, 700.0))
                with self.assertRaises(TimeoutError):
                    SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), 200.0, now=lambda: next(clock), sleep=lambda _: None)
            finally:
                os.close(first)

    def test_cancelled_permit_does_not_take_lock(self):
        state = SUPERVISOR.StopState()
        state.signal = signal.SIGTERM
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "permit"
            with self.assertRaises(InterruptedError):
                SUPERVISOR.acquire_permit(path, state, time.time() + 1)
            acquired = SUPERVISOR.acquire_permit(path, SUPERVISOR.StopState(), time.time() + 1)
            os.close(acquired)

    def test_signal_uses_pidfd_and_rechecks_scope_to_avoid_recycled_pid(self):
        with mock.patch.object(SUPERVISOR, "scope_pids", side_effect=[[12], []]), mock.patch.object(SUPERVISOR.os, "pidfd_open", return_value=123, create=True), mock.patch.object(SUPERVISOR.os, "close") as close, mock.patch.object(SUPERVISOR.signal, "pidfd_send_signal", create=True) as send:
            SUPERVISOR.signal_scope(Path("/scope"), signal.SIGTERM)
            send.assert_not_called()
            close.assert_called_once_with(123)

    def test_unprivileged_term_does_not_prevent_authoritative_cgroup_kill(self):
        with mock.patch.object(SUPERVISOR, "scope_pids", return_value=[12]), mock.patch.object(SUPERVISOR.os, "pidfd_open", return_value=123, create=True), mock.patch.object(SUPERVISOR.os, "close") as close, mock.patch.object(SUPERVISOR.signal, "pidfd_send_signal", side_effect=PermissionError("root entry has not dropped UID yet"), create=True), mock.patch.object(SUPERVISOR, "scope_populated", side_effect=[True, True, False]), mock.patch.object(SUPERVISOR, "kill_scope") as kill, mock.patch.object(SUPERVISOR, "reap_children", return_value=False):
            self.assertTrue(SUPERVISOR.clean_scope(Path("/scope"), {}, grace=0))
            kill.assert_called_once()
            close.assert_called_once_with(123)

    def test_kernel_stuck_scope_has_bounded_cleanup_and_reports_failure(self):
        tick = [0]

        def now():
            tick[0] += 1
            return tick[0]

        with mock.patch.object(SUPERVISOR, "scope_populated", return_value=True), mock.patch.object(SUPERVISOR, "signal_scope"), mock.patch.object(SUPERVISOR, "kill_scope") as kill, mock.patch.object(SUPERVISOR, "reap_children", return_value=True), mock.patch.object(SUPERVISOR, "log") as log:
            self.assertFalse(SUPERVISOR.clean_scope(Path("/scope"), {}, now=now, sleep=lambda _: None))
            kill.assert_called_once()
            self.assertIn("kernel-uninterruptible", log.call_args.args[0])
            self.assertLess(tick[0], 20)


@unittest.skipUnless(sys.platform == "linux" and LINUX_ROOT, "requires Linux and explicit TASK_ORCH_TEST_CGROUP_ROOT delegation")
class LinuxProcessIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="task-orch-supervisor-test-")
        self.work = Path(self.directory.name)
        self.children = []
        self.streams = []
        self.scopes = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        for scope in self.scopes:
            # Only the unique scopes created by this test are ever cleaned.
            if scope.exists():
                SUPERVISOR.kill_scope(scope)
                until = time.time() + 5
                while SUPERVISOR.scope_populated(scope) and time.time() < until:
                    time.sleep(0.05)
                SUPERVISOR.remove_empty_scope(scope)
        for stream in self.streams:
            stream.close()
        self.directory.cleanup()

    def launch(self, code, overrides=None):
        instance = "test-" + uuid.uuid4().hex
        script = self.work / (instance + ".py")
        script.write_text(code)
        env = dict(os.environ, TASK_ORCH_PROCESS_MEMORY_MAX_BYTES=str(512 * 1024**2),
                   TASK_ORCH_PROCESS_SWAP_MAX_BYTES="0", TASK_ORCH_PROCESS_PIDS_MAX="48")
        env.update(overrides or {})
        output = open(self.work / (instance + ".log"), "w+")
        self.streams.append(output)
        child = subprocess.Popen([sys.executable, str(SCRIPT), "worker", "--instance", instance,
                                  "--cgroup-root", LINUX_ROOT, "--", sys.executable, str(script)],
                                 env=env, stdout=output, stderr=output)
        self.children.append(child)
        self.scopes.append(Path(LINUX_ROOT) / ("u" + str(os.getuid())) / instance)
        return child

    def wait_for(self, path, timeout=10):
        until = time.time() + timeout
        while time.time() < until:
            if path.exists() and path.read_text().strip():
                return path.read_text().strip()
            time.sleep(0.05)
        self.fail("timed out waiting for " + str(path) + "; logs: " + self.logs())

    def logs(self):
        return "\n".join(path.read_text() for path in self.work.glob("*.log"))

    def assert_gone(self, pid):
        until = time.time() + 5
        while time.time() < until:
            if not Path("/proc", str(pid)).exists():
                return
            time.sleep(0.05)
        self.fail("descendant remains in /proc: " + str(pid))

    def detached_workload(self, path):
        return ("import os, time\n"
                "if os.fork() == 0:\n"
                " os.setsid()\n"
                " if os.fork() != 0: os._exit(0)\n"
                " open(" + repr(str(path)) + ", 'w').write(str(os.getpid()))\n"
                " while True: time.sleep(1)\n"
                "time.sleep(0.3)\n")

    def test_worker_exit_reaps_double_fork_setsid_descendant(self):
        marker = self.work / "orphan.pid"
        child = self.launch(self.detached_workload(marker))
        pid = int(self.wait_for(marker))
        self.assertEqual(child.wait(timeout=12), 0, self.logs())
        self.assert_gone(pid)
        self.assertFalse(self.scopes[-1].exists())

    def test_sigkill_of_service_supervisor_does_not_leave_orphans(self):
        marker = self.work / "orphan.pid"
        child = self.launch(self.detached_workload(marker) + "time.sleep(60)\n")
        pid = int(self.wait_for(marker))
        child.kill()
        child.wait(timeout=3)
        self.assert_gone(pid)

    def test_sigkill_of_inner_guardian_is_cleaned_by_outer_subreaper(self):
        marker = self.work / "identity"
        code = "import os,time\nopen(" + repr(str(marker)) + ",'w').write(str(os.getpid()) + ' ' + str(os.getppid()))\ntime.sleep(60)\n"
        child = self.launch(code)
        workload = int(self.wait_for(marker).split()[0])
        # Initial non-root entry may have a transient sudo monitor between
        # worker and guardian; identify the actual outer supervisor's child.
        guardian = int(Path("/proc", str(child.pid), "task", str(child.pid), "children").read_text().strip())
        os.kill(guardian, signal.SIGKILL)
        self.assertEqual(child.wait(timeout=12), 137, self.logs())
        self.assert_gone(workload)

    def test_command_exit_reaps_descendants_and_worker_continues(self):
        marker = self.work / "command-orphan.pid"
        done = self.work / "done"
        code = ("import os, subprocess, sys, time\n"
                "command = [sys.executable, os.environ['TASK_ORCH_PROCESS_SUPERVISOR'], 'command', '--', sys.executable, '-c', "
                + repr(self.detached_workload(marker)) + "]\n"
                "result = subprocess.run(command)\n"
                "assert result.returncode == 0, result.returncode\n"
                "assert not os.path.exists('/proc/' + open(" + repr(str(marker)) + ").read())\n"
                "open(" + repr(str(done)) + ",'w').write('worker continued')\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=15), 0, self.logs())
        self.assertEqual(self.wait_for(done), "worker continued")

    def test_commands_share_one_permit_across_nested_clients(self):
        path = self.work / "sequence"
        command = ("import os,time\nf=open(" + repr(str(path)) + ",'a')\n"
                   "f.write('start\\n'); f.flush(); time.sleep(0.25); f.write('end\\n'); f.close()\n")
        code = ("import os,subprocess,sys\n"
                "argv=[sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--',sys.executable,'-c'," + repr(command) + "]\n"
                "children=[subprocess.Popen(argv) for _ in range(4)]\n"
                "assert [c.wait() for c in children] == [0,0,0,0]\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=15), 0, self.logs())
        self.assertEqual(path.read_text().splitlines(), ["start", "end"] * 4)

    def test_cancelled_command_reaps_orphan_without_stopping_worker(self):
        marker = self.work / "cancel-orphan.pid"
        command = self.detached_workload(marker) + "time.sleep(60)\n"
        code = ("import os,subprocess,sys,time\n"
                "child=subprocess.Popen([sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--',sys.executable,'-c'," + repr(command) + "])\n"
                "while not os.path.exists(" + repr(str(marker)) + "): time.sleep(.05)\n"
                "child.terminate()\nassert child.wait(timeout=10) == 143\n"
                "assert not os.path.exists('/proc/' + open(" + repr(str(marker)) + ").read())\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=15), 0, self.logs())

    def test_abrupt_command_wrapper_loss_keeps_permit_until_orphans_are_cleaned(self):
        marker = self.work / "killed-command-orphan.pid"
        command = self.detached_workload(marker) + "time.sleep(60)\n"
        followup = "import os\nassert not os.path.exists('/proc/' + open(" + repr(str(marker)) + ").read())\n"
        code = ("import os,subprocess,sys,time\n"
                "base=[sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--',sys.executable,'-c']\n"
                "child=subprocess.Popen(base + [" + repr(command) + "])\n"
                "while not os.path.exists(" + repr(str(marker)) + "): time.sleep(.05)\n"
                "child.kill(); child.wait()\n"
                "assert subprocess.run(base + [" + repr(followup) + "]).returncode == 0\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=15), 0, self.logs())

    def test_worker_parent_loss_during_active_command_cleans_entire_tree(self):
        marker = self.work / "active-command.pid"
        identities = self.work / "worker.pid"
        command = self.detached_workload(marker) + "time.sleep(60)\n"
        code = ("import os,subprocess,sys,time\n"
                "open(" + repr(str(identities)) + ",'w').write(str(os.getpid()))\n"
                "subprocess.run([sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--',sys.executable,'-c'," + repr(command) + "])\n")
        child = self.launch(code)
        orphan = int(self.wait_for(marker))
        os.kill(int(self.wait_for(identities)), signal.SIGKILL)
        self.assertEqual(child.wait(timeout=15), 137, self.logs())
        self.assert_gone(orphan)
        self.assertFalse(self.scopes[-1].exists())

    def test_command_deadline_expires_after_supervisor_resume(self):
        marker = self.work / "pause-workload.pid"
        command = "import os,time\nopen(" + repr(str(marker)) + ",'w').write(str(os.getpid()))\ntime.sleep(60)\n"
        code = ("import os,signal,subprocess,sys,time\n"
                "child=subprocess.Popen([sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--timeout-seconds','1','--',sys.executable,'-c'," + repr(command) + "])\n"
                "while not os.path.exists(" + repr(str(marker)) + "): time.sleep(.02)\n"
                "guardian=int(open('/proc/' + str(child.pid) + '/task/' + str(child.pid) + '/children').read().strip())\n"
                "os.kill(child.pid,signal.SIGSTOP); os.kill(guardian,signal.SIGSTOP)\ntime.sleep(1.5)\n"
                "os.kill(guardian,signal.SIGCONT); os.kill(child.pid,signal.SIGCONT)\n"
                "assert child.wait(timeout=10) == 124\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=15), 0, self.logs())
        self.assert_gone(int(marker.read_text()))

    @unittest.skipIf(NAMESPACE_ROOT, "namespace OOM uses the aggregate budget test")
    def test_memory_limit_ooms_workload_but_surviving_supervisor_cleans_scope(self):
        child = self.launch("data=[]\nwhile True: data.append(bytearray(8*1024*1024))\n",
                            {"TASK_ORCH_PROCESS_MEMORY_MAX_BYTES": str(64 * 1024**2)})
        self.assertEqual(child.wait(timeout=15), 137, self.logs())
        self.assertFalse(self.scopes[-1].exists())

    @unittest.skipIf(NAMESPACE_ROOT, "populated namespace cannot delegate command-local memory isolation")
    def test_compiler_command_oom_fails_only_its_tool_and_worker_can_continue(self):
        marker = self.work / "after-compiler-oom"
        compiler = "data=[]\nwhile True: data.append(bytearray(8*1024*1024))\n"
        code = ("import os,subprocess,sys\n"
                "base=[sys.executable,os.environ['TASK_ORCH_PROCESS_SUPERVISOR'],'command','--',sys.executable,'-c']\n"
                "result=subprocess.run(base + [" + repr(compiler) + "])\n"
                "assert result.returncode == 137, result.returncode\n"
                "assert subprocess.run(base + ['pass']).returncode == 0\n"
                "open(" + repr(str(marker)) + ",'w').write('worker survived')\n")
        child = self.launch(code)
        self.assertEqual(child.wait(timeout=20), 0, self.logs())
        self.assertEqual(self.wait_for(marker), "worker survived")
        self.assertFalse(self.scopes[-1].exists())

    def test_worker_entry_preserves_user_environment_without_chmod_of_host_cgroup(self):
        marker = self.work / "entry-verified"
        host_procs = Path("/sys/fs/cgroup/cgroup.procs")
        before = host_procs.stat()
        code = ("import os\n"
                "assert os.getuid() == " + str(os.getuid()) + "\n"
                "assert os.getgid() == " + str(os.getgid()) + "\n"
                "assert os.environ['TASK_ORCH_ENTRY_TEST_VALUE'] == 'test-only-value'\n"
                "assert os.environ['TASK_ORCH_PROCESS_CGROUP'] in '/sys/fs/cgroup' + open('/proc/self/cgroup').read().split('0::')[1].strip()\n"
                "open(" + repr(str(marker)) + ",'w').write('entry verified')\n")
        child = self.launch(code, {"TASK_ORCH_ENTRY_TEST_VALUE": "test-only-value"})
        self.assertEqual(child.wait(timeout=15), 0, self.logs())
        self.assertEqual(self.wait_for(marker), "entry verified")
        after = host_procs.stat()
        self.assertEqual((after.st_uid, after.st_gid, after.st_mode), (before.st_uid, before.st_gid, before.st_mode))

    def test_fork_cap_is_aggregate_and_reports_eagain(self):
        marker = self.work / "bounded"
        code = ("import errno,os,time\nchildren=[]\n"
                "try:\n"
                " for _ in range(100):\n"
                "  pid=os.fork()\n"
                "  if pid == 0: time.sleep(60); os._exit(0)\n"
                "  children.append(pid)\n"
                "except OSError as error:\n"
                " assert error.errno == errno.EAGAIN\n"
                " open(" + repr(str(marker)) + ",'w').write(str(len(children)))\n")
        limit = 48 if NAMESPACE_ROOT else 16
        child = self.launch(code, {"TASK_ORCH_PROCESS_PIDS_MAX": str(limit)})
        self.assertEqual(child.wait(timeout=15), 0, self.logs())
        self.assertLess(int(self.wait_for(marker)), limit)
        self.assertFalse(self.scopes[-1].exists())

    @unittest.skipUnless(NAMESPACE_ROOT, "requires an isolated populated cgroup namespace")
    def test_namespace_budget_bounds_oom_and_preserves_provider_init(self):
        mount = Path("/sys/fs/cgroup")
        initial = (mount / "cgroup.procs").read_text().split()
        child = self.launch("data=[]\nwhile True: data.append(bytearray(8*1024*1024))\n")
        self.assertEqual(child.wait(timeout=20), 137, self.logs())
        self.assertFalse(self.scopes[-1].exists())
        self.assertEqual((mount / "memory.max").read_text().strip(), str(512 * 1024**2))
        self.assertEqual((mount / "memory.swap.max").read_text().strip(), "0")
        self.assertEqual((mount / "pids.max").read_text().strip(), "48")
        self.assertEqual((mount / "cgroup.subtree_control").read_text().strip(), "")
        self.assertIn("1", initial)
        self.assertIn("1", (mount / "cgroup.procs").read_text().split())
        self.assertGreater(int(dict(line.split() for line in (mount / "memory.events").read_text().splitlines())["oom_kill"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
