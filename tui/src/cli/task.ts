// `orch task …` → the repo-root cli.ts, unchanged (PRD §8).
//
// Why a child process rather than an import: cli.ts is TypeScript that imports
// ./lib/* and ./db directly, opens SQLite, and reads .env.local relative to the
// process cwd. Importing it would drag the whole server graph — drizzle,
// better-sqlite3, the Claude SDK — into a package that deliberately depends on
// nothing but ink and react, and `npm run build:orch` bundles this entry, so
// that graph would have to bundle too (it cannot: native modules). Spawning
// `tsx cli.ts` from the repo root is the same thing `npm run task -- …` does,
// which is exactly the behaviour this verb promises to preserve. Its exit code
// is ours, and stdio is inherited so streaming output and prompts still work.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Injected so the resolution is testable without a filesystem. */
export type Exists = (path: string) => boolean;

export interface TaskSpawn {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * The repo root: the nearest ancestor of `from` holding cli.ts. Walking up
 * covers both ways this file runs — `<repo>/tui/src/cli/task.ts` under tsx and
 * `<repo>/dist/orch.js` as a bundle — without either path being written down.
 */
export function findRepoRoot(from: string, exists: Exists = existsSync): string | null {
  let dir = resolve(from);
  for (;;) {
    if (exists(join(dir, "cli.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * How to run `cli.ts` with `args`. The root's own tsx is preferred because it
 * is the one `npm run task` uses; `npx --no-install` is the fallback for an
 * install that hoisted it elsewhere, and it fails loudly rather than
 * downloading tsx behind the operator's back. cwd is the repo root, not the
 * caller's directory: cli.ts loads `.env.local` by relative path, and a task
 * CLI that cannot see the database is worse than no delegation at all.
 */
export function taskSpawn(root: string, args: readonly string[], exists: Exists = existsSync): TaskSpawn {
  const local = join(root, "node_modules", ".bin", "tsx");
  const cli = join(root, "cli.ts");
  if (exists(local)) return { command: local, args: [cli, ...args], cwd: root };
  return { command: "npx", args: ["--no-install", "tsx", cli, ...args], cwd: root };
}
