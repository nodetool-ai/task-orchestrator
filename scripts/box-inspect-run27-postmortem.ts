// Fork run 27's FAILED box checkpoint (bx_h7vk7rmy) and inspect the exact
// post-failure filesystem: worker session logs, the cwd the SDK spawned with,
// and whether the run's repo exists at all. Fork removed in finally.
import { makeBoxClient } from "../lib/runner/box-client";
import { waitForBoxReady } from "../lib/runner/box-waiters";

const FAILED_BOX = "bx_h7vk7rmy";

async function main(): Promise<void> {
  if (process.env.BOX_LIVE_TEST !== "1") throw new Error("set BOX_LIVE_TEST=1");
  const client = makeBoxClient();
  let forkId: string | undefined;
  try {
    const fork = await client.fork(FAILED_BOX, { noEnv: true, env: { PROBE: "postmortem" } });
    forkId = fork.id;
    await waitForBoxReady(client, forkId, { timeoutMs: 300_000 });
    console.log(`[pm] forked failed box -> ${forkId}`);

    const cmd = [
      `set +e`,
      `echo "== session roots =="; ls -la /home/user/.task-orchestrator/ 2>/dev/null; find /home/user -maxdepth 3 -name "runner.log" 2>/dev/null | head`,
      `echo "== runner.log tail =="; tail -n 60 $(find /home/user -maxdepth 5 -name runner.log 2>/dev/null | head -1) 2>/dev/null`,
      `echo "== worktrees / repos present =="; ls /home/user/ 2>/dev/null; ls /home/user/nodetool/.git 2>/dev/null >/dev/null && echo nodetool-git-ok; ls -d /home/user/*chess* /Users 2>/dev/null || echo "no chess/no /Users"`,
      `echo "== worktree dirs =="; find /home/user -maxdepth 4 -type d -name "*worktree*" 2>/dev/null | head; find /tmp /home/user -maxdepth 4 -type d -name "*wt*" 2>/dev/null | head -5`,
      `echo "== free mem =="; free -m 2>/dev/null | head -3`,
      `echo "== exec binary here =="; /home/user/task-orchestrator/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version 2>&1 | head -1; echo exit=$?`,
    ].join("; ");
    const res = await client.command(forkId, { command: cmd, timeoutSeconds: 120 });
    console.log(res.stdout ?? "");
    if ((res.stderr ?? "").trim()) console.log("STDERR:", res.stderr);
  } finally {
    if (forkId) {
      try { await client.remove(forkId); console.log(`[pm] removed ${forkId}`); }
      catch (e) { console.log(`[pm] remove failed: ${(e as Error).message}`); }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
