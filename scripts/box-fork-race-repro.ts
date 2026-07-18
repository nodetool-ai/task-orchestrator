// Minimal repro for the archive→immediate-fork race suspected in runs 26/27:
// a fork taken seconds after a template's checkpoint completes sees a large
// binary that cannot exec, while later forks of the same template are fine.
//
// Blank box → copy a big preinstalled ELF to a fresh path → sha256 + exec it →
// sync → stop/archive → wait checkpoint → fork IMMEDIATELY → sha256 + exec in
// the fork. Any divergence (checksum mismatch, exec failure) proves the
// provider-side race with ~3 minutes of box time instead of a 12-minute build.
// Both boxes are removed in finally.
import { makeBoxClient } from "../lib/runner/box-client";
import { waitForBoxCheckpoint, waitForBoxReady } from "../lib/runner/box-waiters";

const SRC = "/usr/local/bin/claude"; // ~250MB ELF preinstalled in the base image
const DST = "/home/user/fork-race-probe-bin";

async function main(): Promise<void> {
  if (process.env.BOX_LIVE_TEST !== "1") throw new Error("set BOX_LIVE_TEST=1");
  const client = makeBoxClient();
  let tplId: string | undefined;
  let forkId: string | undefined;
  try {
    const blank = await client.create({ env: {}, noEnv: true });
    tplId = blank.id;
    await waitForBoxReady(client, tplId);
    console.log(`[repro] blank box ${tplId} ready`);

    const prep = await client.command(tplId, {
      timeoutSeconds: 120,
      command:
        `set -e; test -x ${SRC} || { echo "no ${SRC}"; ls /usr/local/bin | head; exit 9; }; ` +
        `cp ${SRC} ${DST}; sync; ` +
        `sha256sum ${DST} | cut -c1-24; ${DST} --version 2>&1 | head -1; echo prep-exit=$?`,
    });
    console.log(`[repro] template prep:\n${prep.stdout}`);
    if (prep.exitCode !== 0) throw new Error(`prep failed: ${prep.stderr || prep.stdout}`);

    const requestedAt = Date.now();
    await client.stop(tplId);
    await waitForBoxCheckpoint(client, tplId, requestedAt, { timeoutMs: 600_000 });
    const checkpointDone = Date.now();
    console.log(`[repro] checkpoint completed in ${checkpointDone - requestedAt}ms; forking IMMEDIATELY`);

    const fork = await client.fork(tplId, { noEnv: true, env: { PROBE: "fork-race" } });
    forkId = fork.id;
    await waitForBoxReady(client, forkId);
    const readyAt = Date.now();
    console.log(`[repro] fork ${forkId} ready ${readyAt - checkpointDone}ms after checkpoint`);

    const check = await client.command(forkId, {
      timeoutSeconds: 120,
      command:
        `set +e; stat -c '%s' ${DST}; sha256sum ${DST} | cut -c1-24; ` +
        `${DST} --version 2>&1 | head -2; echo exec-exit=$?`,
    });
    console.log(`[repro] fork check (+${Date.now() - checkpointDone}ms after checkpoint):\n${check.stdout}`);
    if ((check.stderr ?? "").trim()) console.log("STDERR:", check.stderr);
  } finally {
    for (const id of [forkId, tplId]) {
      if (!id) continue;
      try { await client.remove(id); console.log(`[repro] removed ${id}`); }
      catch (e) { console.log(`[repro] remove ${id} failed: ${(e as Error).message}`); }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
