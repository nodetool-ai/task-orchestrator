#!/usr/bin/env node
// The `orch` bin target. Two ways to run the cockpit, one entry point:
//
//   • a git checkout      → tui/src/orch.tsx through tsx (always current, no
//                           build step, what a developer wants)
//   • a built artifact    → dist/orch.js (what an image ships; no tsx, no
//                           TypeScript, no tui/node_modules needed)
//
// Source wins when tsx is resolvable, so a stale dist/orch.js can never
// silently shadow the code you are editing. Set ORCH_BUNDLE=1 to force the
// bundle (faster start: no transpile) or to smoke-test the built artifact.
//
// Note the bundle is executable on its own — inside the server image `orch`
// is a symlink to /app/dist/orch.js and this shim is not present at all. That
// is deliberate: shipping a bin that needs tsx at runtime would make tsx a
// production dependency of the image, and it is a devDependency.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/tui/bin
const tuiRoot = resolve(here, "..");
const repoRoot = resolve(tuiRoot, "..");
const args = process.argv.slice(2);

const entry = join(tuiRoot, "src", "orch.tsx");
// Repo-root dist/ is where `npm run build:orch` writes; the tui-local path is
// a courtesy for anyone who builds inside the package.
const bundle = [join(repoRoot, "dist", "orch.js"), join(tuiRoot, "dist", "orch.js")].find(existsSync);

function hasTsx() {
  try {
    createRequire(join(tuiRoot, "package.json")).resolve("tsx");
    return true;
  } catch {
    return false;
  }
}

async function runBundle() {
  // In-process import, not a subprocess: the TUI needs the real stdin TTY for
  // raw mode, and process.argv already reads correctly (argv[1] is this shim,
  // so the entry's process.argv.slice(2) is unchanged).
  await import(pathToFileURL(bundle).href);
}

function runSource() {
  const child = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    stdio: "inherit",
    cwd: tuiRoot,
  });
  if (child.error) {
    process.stderr.write(`orch: could not start tsx — ${child.error.message}\n`);
    process.exit(2);
  }
  process.exit(child.status ?? 1);
}

if (bundle && (process.env.ORCH_BUNDLE === "1" || !existsSync(entry) || !hasTsx())) {
  await runBundle();
} else if (existsSync(entry) && hasTsx()) {
  runSource();
} else if (bundle) {
  await runBundle();
} else {
  process.stderr.write(
    "orch: no runnable entry point.\n" +
      `  source: ${entry} ${existsSync(entry) ? "(present, but tsx is not installed — run `npm ci` in tui/)" : "(missing)"}\n` +
      "  bundle: dist/orch.js (missing — run `npm run build:orch` from the repo root)\n",
  );
  process.exit(2);
}
