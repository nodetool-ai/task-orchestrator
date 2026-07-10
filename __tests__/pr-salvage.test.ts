// The salvage half of "the worker can finish the PR from whatever is on the
// branch": when an agent ends its work without committing, the turn-end sync
// commits the leftovers (git add -A + commit) before pushing and opening the
// PR. commitLeftoverChanges is the pure-git piece — exercised here against a
// throwaway repository.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitLeftoverChanges } from "../lib/runs";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "salvage-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("commitLeftoverChanges", () => {
  it("commits modified, new, and deleted files in one salvage commit", async () => {
    writeFileSync(join(repo, "base.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "new file\n");
    const committed = await commitLeftoverChanges(repo, "chore(T-1): commit remaining agent work");
    expect(committed).toBe(true);
    // The tree is clean afterwards and the commit carries the message.
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(git("log", "-1", "--format=%s").trim()).toBe(
      "chore(T-1): commit remaining agent work"
    );
    expect(git("show", "--stat", "--format=", "HEAD")).toContain("new.txt");
  });

  it("is a no-op on a clean tree", async () => {
    const before = git("rev-parse", "HEAD").trim();
    const committed = await commitLeftoverChanges(repo, "should not happen");
    expect(committed).toBe(false);
    expect(git("rev-parse", "HEAD").trim()).toBe(before);
  });

  it("picks up untracked files (git add -A, not just tracked updates)", async () => {
    writeFileSync(join(repo, "untracked.bin"), "data");
    expect(await commitLeftoverChanges(repo, "salvage")).toBe(true);
    expect(git("ls-files")).toContain("untracked.bin");
  });
});
