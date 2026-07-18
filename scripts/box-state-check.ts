// Read the live state of the runs-26/27 boxes (postmortem support; read-only).
import { makeBoxClient } from "../lib/runner/box-client";
const c = makeBoxClient();
for (const id of process.argv.slice(2)) {
  try {
    const b = await c.get(id);
    console.log(id, "->", b.state);
  } catch (e) {
    console.log(id, "ERR", (e as Error).message);
  }
}
