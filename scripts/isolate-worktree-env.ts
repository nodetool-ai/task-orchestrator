// Isolate the current worktree's environment.
//
// Worktrees share the repo root's `node_modules` and Turbopack/Next.js build
// cache (`.next`) by default — fast to spin up, but a shared store. Run this
// from inside a worktree to give it a PRIVATE node_modules and build cache, so
// you can add/upgrade/remove dependencies (or get a clean build) without
// affecting the other worktrees running concurrently:
//
//   npm run isolate-env
//
// It removes the shared symlinks (leaving any already-private dir untouched),
// then runs a fresh `npm install` so this worktree has its own dependency tree.

import { spawnSync } from "node:child_process";
import { unlinkSharedWorktreeArtifacts } from "../lib/worktree-env";

const cwd = process.cwd();

const unlinked = await unlinkSharedWorktreeArtifacts(cwd);
if (unlinked.length > 0) {
  console.log(`Unlinked shared: ${unlinked.join(", ")}`);
} else {
  console.log(
    "No shared symlinks found — this worktree already has a private environment."
  );
}

console.log("Installing private dependencies (npm install)…");
const res = spawnSync("npm", ["install"], { stdio: "inherit", cwd });
if (res.status !== 0) {
  console.error(
    "npm install failed — this worktree may have no usable node_modules."
  );
  process.exit(res.status ?? 1);
}

console.log("Done. This worktree now has its own node_modules and build cache.");
