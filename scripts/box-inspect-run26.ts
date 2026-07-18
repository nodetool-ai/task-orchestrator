// Disposable probe: fork the exact template run 26 used (bx_9ktc57j4) and
// inspect the libc / claude-code binary situation that made the agent fail to
// launch. Removes the fork in finally. Logs no credentials or URLs.
import { makeBoxClient } from "../lib/runner/box-client";
import { waitForBoxReady } from "../lib/runner/box-waiters";

const TEMPLATE_ID = process.env.PROBE_TEMPLATE_ID ?? "bx_9ktc57j4";
const REPO = "/home/user/task-orchestrator";

async function main(): Promise<void> {
  if (process.env.BOX_LIVE_TEST !== "1") throw new Error("set BOX_LIVE_TEST=1 to run");
  if (!process.env.BOX_API_KEY) throw new Error("BOX_API_KEY required");
  const client = makeBoxClient();
  let boxId: string | undefined;
  try {
    const fork = await client.fork(TEMPLATE_ID, { noEnv: true, env: { PROBE: "run26" } });
    boxId = fork.id;
    console.log(`[probe] forked ${TEMPLATE_ID} -> ${boxId}, waiting ready…`);
    await waitForBoxReady(client, boxId);

    const sdkDir = `${REPO}/node_modules/@anthropic-ai/claude-agent-sdk`;
    const cmd = [
      `set +e`,
      `echo "== /home/user layout =="; ls -la /home/user 2>/dev/null | grep -vE '^total'`,
      `echo "== task-orch present? =="; ls -d ${REPO} 2>/dev/null || echo "NO ${REPO}"`,
      `echo "== template manifest =="; cat /home/user/.task-orchestrator/template.json 2>/dev/null || echo "no manifest"`,
      `echo "== task-orch sdk variants =="; ls -d ${REPO}/node_modules/@anthropic-ai/claude-agent-sdk-linux* 2>/dev/null || echo "none"`,
      `echo "== task-orch bundled binary (the run26 path) =="; B=${sdkDir}-linux-x64/claude; ls -l "$B" 2>/dev/null && file "$B" 2>/dev/null && (ldd "$B" 2>&1 | head -8)`,
      `echo "== try launch task-orch bundled binary =="; "$B" --version 2>&1 | head -3; echo "exit=$?"`,
      `echo "== task-orch sdk version =="; node -e "console.log(require('${sdkDir}/package.json').version)" 2>&1 || true`,
      `echo "== git HEAD of task-orch =="; git -C ${REPO} rev-parse --short HEAD 2>&1; git -C ${REPO} log -1 --format='%ci %s' 2>&1`,
    ].join("; ");

    const res = await client.command(boxId, { command: cmd, timeoutSeconds: 60 });
    console.log("---- BOX OUTPUT ----");
    console.log((res as any).stdout ?? "");
    const stderr = (res as any).stderr ?? "";
    if (stderr.trim()) console.log("---- STDERR ----\n" + stderr);
    console.log("---- exitCode:", (res as any).exitCode, "----");
  } finally {
    if (boxId) {
      try { await client.remove(boxId); console.log(`[probe] removed ${boxId}`); }
      catch (e) { console.log(`[probe] remove failed: ${(e as Error).message}`); }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
