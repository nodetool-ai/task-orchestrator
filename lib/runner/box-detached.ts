// lib/runner/box-detached.ts
//
// Detached long-step execution on a Box. Each Box `command` call has a
// platform-enforced max duration well under a long npm ci or git clone, so a
// step is LAUNCHED detached (setsid, output + exit code redirected to marker
// files) via one short call, then POLLED with short calls until it finishes
// or the budget elapses. Extracted from box-template-builder so blank
// provisioning (box.ts) shares the proven pattern.
import type { BoxClient } from "./box-client";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runDetachedBoxStep(
  client: BoxClient,
  boxId: string,
  label: string,
  command: string,
  opts: {
    timeoutSeconds: number;
    pollMs: number;
    callTimeoutSeconds?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const callTimeout = opts.callTimeoutSeconds ?? 60;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const base = `/tmp/tmpl-step-${label}`;
  const inner = `(${command}) > ${base}.log 2>&1; echo $? > ${base}.rc`;
  const launch = `rm -f ${base}.rc ${base}.log; setsid sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & echo launched`;
  const started = await client.command(boxId, { command: launch, cwd: ".", timeoutSeconds: callTimeout });
  if (!started.success || started.timedOut || started.exitCode !== 0) {
    const detail = (started.stderr || started.stdout || "").slice(-500);
    throw new Error(`${label} failed to launch: ${detail}`);
  }

  const readTail = async (): Promise<string> => {
    try {
      const t = await client.command(boxId, {
        command: `tail -c 2000 ${base}.log 2>/dev/null || true`,
        cwd: ".",
        timeoutSeconds: callTimeout,
      });
      return (t.stdout ?? "").slice(-2_000);
    } catch {
      return "(log unavailable)";
    }
  };

  const deadline = now() + opts.timeoutSeconds * 1000;
  for (;;) {
    await sleep(opts.pollMs);
    if (now() > deadline) {
      throw new Error(`${label} timed out after ${opts.timeoutSeconds}s: ${await readTail()}`);
    }
    const probe = await client.command(boxId, {
      command: `if [ -f ${base}.rc ]; then cat ${base}.rc; else echo __running__; fi`,
      cwd: ".",
      timeoutSeconds: callTimeout,
    });
    if (!probe.success || probe.timedOut) continue;
    const out = (probe.stdout ?? "").trim();
    if (out === "" || out === "__running__") continue;
    const rc = Number.parseInt(out, 10);
    if (Number.isNaN(rc)) continue;
    if (rc === 0) return;
    throw new Error(`${label} failed (exit ${rc}): ${await readTail()}`);
  }
}
