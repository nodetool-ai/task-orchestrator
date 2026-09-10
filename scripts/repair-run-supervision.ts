// node --import tsx scripts/repair-run-supervision.ts <prior> <replacement> <expected-parent> [--apply]
// Set DATABASE_URL for the target deployment. Default is a dry run.
import { closeDb } from "../db";
import { repairReplacementSupervision } from "../lib/run-supervision-repair";

const [priorId, replacementId, expectedParentId] = process.argv.slice(2, 5).map(Number);
if (![priorId, replacementId, expectedParentId].every(id => Number.isSafeInteger(id) && id > 0)) {
  throw new Error("Usage: repair-run-supervision.ts <prior> <replacement> <expected-parent> [--apply]");
}
try {
  console.log(JSON.stringify(await repairReplacementSupervision({
    priorId, replacementId, expectedParentId, apply: process.argv.includes("--apply"),
  }), null, 2));
} finally {
  await closeDb();
}
