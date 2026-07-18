// Probe run 27's failure: the template's pre-archive verify PASSED, yet the
// fork could not exec the same binary. Compare the binary in (a) run 27's
// actual failed box and (b) a fresh fork of its template. Only the fresh fork
// is removed; run 27's box is evidence and stays.
import { makeBoxClient } from "../lib/runner/box-client";
import { waitForBoxReady } from "../lib/runner/box-waiters";

const FAILED_BOX = "bx_h7vk7rmy"; // run 27's box (stopped, checkpointed)
const TEMPLATE_ID = "bx_w62x75py"; // template whose verify passed at 16:24

const BIN = "/home/user/task-orchestrator/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
const PROBE_CMD =
  `set +e; echo "== stat =="; stat -c '%s %Y %U' ${BIN} 2>&1; ` +
  `echo "== sha256 (first) =="; sha256sum ${BIN} 2>&1 | cut -c1-24; ` +
  `echo "== file =="; file -b ${BIN} 2>&1 | head -1; ` +
  `echo "== exec =="; ${BIN} --version 2>&1 | head -2; echo "exit=$?"`;

async function probe(label: string, boxId: string): Promise<void> {
  const client = makeBoxClient();
  console.log(`\n#### ${label} (${boxId})`);
  const res = await client.command(boxId, { command: PROBE_CMD, timeoutSeconds: 120 });
  console.log(res.stdout ?? "");
  if ((res.stderr ?? "").trim()) console.log("STDERR:", res.stderr);
  console.log("commandExit:", res.exitCode, "timedOut:", res.timedOut);
}

async function main(): Promise<void> {
  if (process.env.BOX_LIVE_TEST !== "1") throw new Error("set BOX_LIVE_TEST=1");
  const client = makeBoxClient();

  // (a) run 27's actual failed box — command should wake it from stopped.
  try {
    await probe("run 27 failed box", FAILED_BOX);
  } catch (e) {
    console.log(`[probe] failed box unreachable: ${(e as Error).message}`);
  }

  // (b) fresh fork of the template whose in-builder verify passed.
  let forkId: string | undefined;
  try {
    const fork = await client.fork(TEMPLATE_ID, { noEnv: true, env: { PROBE: "run27" } });
    forkId = fork.id;
    await waitForBoxReady(client, forkId);
    await probe("fresh fork of template", forkId);
  } finally {
    if (forkId) {
      try { await client.remove(forkId); console.log(`[probe] removed ${forkId}`); }
      catch (e) { console.log(`[probe] remove failed: ${(e as Error).message}`); }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
