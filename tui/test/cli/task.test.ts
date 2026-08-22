// `orch task …` must keep behaving like `npm run task -- …`, and the two
// things that decide whether it does are the root it finds and the command it
// builds. Both are pure over an injected `exists`, so neither needs a repo.

import { describe, expect, it } from "vitest";
import { findRepoRoot, taskSpawn } from "../../src/cli/task.js";

const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("findRepoRoot", () => {
  it("walks up to the directory holding cli.ts", () => {
    const exists = has("/repo/cli.ts");
    // Both ways the entry runs: source under tsx, and the esbuild bundle.
    expect(findRepoRoot("/repo/tui/src/cli", exists)).toBe("/repo");
    expect(findRepoRoot("/repo/dist", exists)).toBe("/repo");
    expect(findRepoRoot("/repo", exists)).toBe("/repo");
  });

  it("gives up rather than guessing when there is no checkout", () => {
    expect(findRepoRoot("/opt/app/dist", has("/opt/app/package.json"))).toBeNull();
  });
});

describe("taskSpawn", () => {
  it("runs the root's own tsx against cli.ts, from the repo root", () => {
    // cwd is load-bearing: cli.ts reads .env.local by relative path.
    expect(taskSpawn("/repo", ["list", "--json"], has("/repo/node_modules/.bin/tsx"))).toEqual({
      command: "/repo/node_modules/.bin/tsx",
      args: ["/repo/cli.ts", "list", "--json"],
      cwd: "/repo",
    });
  });

  it("falls back to npx without installing anything behind the operator's back", () => {
    expect(taskSpawn("/repo", ["help"], () => false)).toEqual({
      command: "npx",
      args: ["--no-install", "tsx", "/repo/cli.ts", "help"],
      cwd: "/repo",
    });
  });
});
