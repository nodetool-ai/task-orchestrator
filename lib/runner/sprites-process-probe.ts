// Service state is supervisor metadata, not an observation of /proc. Sprites
// can retain a running PID after its process exits (production runs 295/298).
// Keep this probe independent of executable names, login shells and disk I/O.
import type { SpritesClient } from "./sprites-client";

export type SpriteProcessObservation = "alive" | "missing" | "replaced" | "unknown";

// Python is also the worker service supervisor's runtime. Read only procfs;
// never emit cmdline, environ, provider service definitions or arbitrary errors.
export const SPRITE_PROCESS_PROBE = `import os, re, sys
pid, instance, generation = sys.argv[1:4]
verdict = "unknown"
try:
    with open("/proc/self/stat") as f:
        f.read()
    target = "/proc/" + pid
    try:
        with open(target + "/stat") as f:
            before = f.read().rsplit(") ", 1)[1].split()
    except FileNotFoundError:
        if not os.path.exists(target):
            verdict = "missing"
    else:
        if len(before) >= 20 and before[0] not in ("Z", "X", "x"):
            verdict = "alive"
            if instance:
                with open(target + "/environ", "rb") as f:
                    values = f.read().split(b"\\0")
                expected = ("TASK_ORCH_WORKER_INSTANCE_ID=" + instance).encode()
                expected_generation = ("TASK_ORCH_WORKER_GENERATION=" + generation).encode()
                if expected not in values or expected_generation not in values:
                    verdict = "replaced"
            with open(target + "/stat") as f:
                after = f.read().rsplit(") ", 1)[1].split()
            if len(after) < 20 or before[19] != after[19] or after[0] in ("Z", "X", "x"):
                verdict = "unknown"
except Exception:
    verdict = "unknown"
if verdict in ("missing", "replaced") and instance:
    try:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", instance):
            raise ValueError("invalid instance")
        scope_root = "/sys/fs/cgroup/task-orchestrator"
        try:
            owners = list(os.scandir(scope_root))
        except FileNotFoundError:
            owners = []
        for owner in owners:
            if not re.fullmatch(r"u[0-9]+", owner.name):
                continue
            scope = os.path.join(owner.path, instance)
            try:
                with open(os.path.join(scope, "cgroup.events")) as f:
                    fields = dict(line.split() for line in f)
            except FileNotFoundError:
                if os.path.exists(scope):
                    verdict = "unknown"
            else:
                # The outer service process can die before its inner guardian
                # finishes reaping. A populated scope includes descendants in
                # every command cgroup, including uninterruptible D-state work.
                if fields.get("populated") != "0":
                    verdict = "unknown"
    except Exception:
        verdict = "unknown"
print("task-orch-process-v1:" + verdict)
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A failed/expired probe is unobservable, never proof that the worker died. */
export async function inspectSpriteProcess(
  client: SpritesClient,
  spriteName: string,
  pid: number,
  identity?: { instanceId: string; generation: number },
): Promise<SpriteProcessObservation> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  return runProbe(client, spriteName, pid, identity);
}

/** An absent/empty containment scope is quiescent. Legacy workers never had a
 * scope. PID 0 has no procfs process entry, so this skips process observation
 * while retaining the same mounted-procfs and cgroup error handling. */
export async function isSpriteScopeQuiescent(
  client: SpritesClient,
  spriteName: string,
  identity: { instanceId: string; generation: number },
): Promise<boolean> {
  return await runProbe(client, spriteName, 0, identity) === "missing";
}

async function runProbe(
  client: SpritesClient,
  spriteName: string,
  pid: number,
  identity?: { instanceId: string; generation: number },
): Promise<SpriteProcessObservation> {
  try {
    const result = await client.exec(spriteName, {
      cmd: ["python3", "-c", shellQuote(SPRITE_PROCESS_PROBE), String(pid),
        shellQuote(identity?.instanceId ?? ""), shellQuote(identity ? String(identity.generation) : "")].join(" "),
      // The provider transport enforces this complete-operation deadline too.
      // A VM resume or storage stall must not hold reconciliation indefinitely.
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    if (result.exitCode !== 0) return "unknown";
    const match = /^task-orch-process-v1:(alive|missing|replaced|unknown)\s*$/.exec(result.stdout);
    return (match?.[1] as SpriteProcessObservation | undefined) ?? "unknown";
  } catch {
    return "unknown";
  }
}
