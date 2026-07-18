// Reproduce the UI's resume of failed run 27: sendMessageToRun + stream frames.
import * as runs from "../lib/runs";

const abort = new AbortController();
const timer = setTimeout(() => { console.log("[repro] 60s timeout — aborting stream"); abort.abort(); }, 60_000);
try {
  for await (const ev of runs.sendMessageToRun({ runId: 27, role: "user", text: "please continue", author: "repro", abort })) {
    console.log("[frame]", JSON.stringify(ev).slice(0, 300));
    if (ev.type === "done" || ev.type === "error") break;
  }
} finally {
  clearTimeout(timer);
}
const after = await runs.get(27);
console.log("[after] status=", after?.status, "error=", (after?.error ?? "").slice(0, 140));
process.exit(0);
