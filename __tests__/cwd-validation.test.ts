import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCwd } from "../lib/runs";

// Regression for the "binary failed to launch" red herring: a repository whose
// local_path points at a non-existent directory used to flow unchecked into the
// agent SDK's spawn cwd, where Node reports it as `ENOENT` against the *binary*.
// validateCwd turns that into an actionable error naming the offending repo.

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

describe("validateCwd", () => {
  it("returns the directory unchanged when it exists", () => {
    const dir = tempDir("cwd-ok-");
    expect(validateCwd(dir, { runId: 1, repoId: "R-nodetool" })).toBe(dir);
  });

  it("throws an actionable error naming the run and repo when the directory is missing", () => {
    const missing = join(tmpdir(), "cwd-missing-does-not-exist-7f3a9");
    expect(() => validateCwd(missing, { runId: 7, repoId: "R-nodetool" })).toThrow(
      /Run #7.*working directory.*does not exist.*R-nodetool/s
    );
  });

  it("falls back to '(default)' in the message when there is no repoId", () => {
    const missing = join(tmpdir(), "cwd-missing-no-repo-7f3a9");
    expect(() => validateCwd(missing, { runId: 3, repoId: null })).toThrow(/\(default\)/);
  });

  it("throws when the path exists but is a file, not a directory", () => {
    const dir = tempDir("cwd-file-");
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => validateCwd(file, { runId: 9, repoId: null })).toThrow(/not a directory/);
  });
});
