// Drops and recreates the DB. Use with care.
//
// Load .env.local FIRST (before anything reads process.env.TASK_ORCH_DB or the
// db module initialises) so `npm run db:reset` targets the same database the
// deployed service uses — mirroring cli.ts / scripts/worktree-gc.ts. The db
// module is imported dynamically below, after this runs, so the path is set.
import { config } from "dotenv";
config({ path: ".env.local" });

import { unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TASK_ORCH_DB
  ? resolve(process.env.TASK_ORCH_DB)
  : resolve(__dirname, "..", "..", "data.db");

for (const suffix of ["", "-shm", "-wal"]) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`Removed ${p}`);
  }
}

async function init() {
  await import("../db");
  console.log(`Initialized ${DB_PATH}`);
}
init();
