import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  collectGitStatus,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  resolveRunCheckout,
} from "../lib/run-git-status";
import type { RunRow } from "../lib/runs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

// One repo shaped like a run's worktree mid-flight: two commits on a branch on
// top of `main`, plus staged, unstaged and untracked work not yet committed.
let repoDir = "";

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "run-git-status-"));
  git(repoDir, "init", "--initial-branch=main");
  writeFileSync(join(repoDir, "kept.txt"), "base\n");
  writeFileSync(join(repoDir, "gone.txt"), "one\ntwo\n");
  writeFileSync(join(repoDir, "moved.txt"), "a\nb\nc\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");

  git(repoDir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repoDir, "added.txt"), "1\n2\n3\n");
  writeFileSync(join(repoDir, "kept.txt"), "base\nmore\n");
  git(repoDir, "rm", "-q", "gone.txt");
  git(repoDir, "mv", "moved.txt", "renamed.txt");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "committed work");

  // Uncommitted: one staged edit, one unstaged edit, one untracked file.
  writeFileSync(join(repoDir, "added.txt"), "1\n2\n3\n4\n");
  git(repoDir, "add", "added.txt");
  writeFileSync(join(repoDir, "kept.txt"), "base\nmore\nstill more\n");
  mkdirSync(join(repoDir, "nested"), { recursive: true });
  writeFileSync(join(repoDir, "nested", "new.txt"), "x\ny\n");
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

describe("collectGitStatus", () => {
  it("separates what the branch committed from what is still uncommitted", async () => {
    const status = await collectGitStatus(repoDir, "main");
    expect(status.available).toBe(true);
    expect(status.branch).toBe("feature");
    expect(status.base).toBe("main");
    expect(status.ahead).toBe(1);

    const committed = Object.fromEntries(
      status.committed.files.map((f) => [f.path, f])
    );
    expect(committed["added.txt"]).toMatchObject({ status: "added", additions: 3, deletions: 0 });
    expect(committed["kept.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(committed["gone.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 2 });
    expect(committed["renamed.txt"]).toMatchObject({ status: "renamed", oldPath: "moved.txt" });
    expect(status.committed.additions).toBe(4);
    expect(status.committed.deletions).toBe(2);
  });

  it("counts staged, unstaged and untracked work in the worktree set", async () => {
    const status = await collectGitStatus(repoDir, "main");
    const working = Object.fromEntries(status.working.files.map((f) => [f.path, f]));

    expect(working["added.txt"]).toMatchObject({ additions: 1, deletions: 0, staged: true });
    expect(working["kept.txt"]).toMatchObject({ additions: 1, deletions: 0, staged: false });
    // Untracked files never show up in `git diff`; their lines still count.
    expect(working["nested/new.txt"]).toMatchObject({
      status: "untracked",
      additions: 2,
      binary: false,
    });
    expect(status.working.additions).toBe(4);
    expect(status.working.deletions).toBe(0);
  });

  it("reports the branch total when the base ref only exists as origin/<base>", async () => {
    // A worktree checked out from a bare clone has no local `main`.
    const status = await collectGitStatus(repoDir, "no-such-branch");
    expect(status.available).toBe(true);
    expect(status.base).toBeNull();
    expect(status.committed.files).toEqual([]);
    // The worktree set never depends on the base ref resolving.
    expect(status.working.files.length).toBeGreaterThan(0);
  });

  it("marks a directory that is not a checkout unavailable instead of throwing", async () => {
    const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      const status = await collectGitStatus(plain, "main");
      expect(status.available).toBe(false);
      expect(status.reason).toContain("not a git checkout");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("resolveRunCheckout", () => {
  const run = (over: Partial<RunRow>) =>
    ({ id: 1, repoId: null, cwdStrategy: "worktree", worktreePath: null, ...over }) as RunRow;

  it("uses a worktree that exists on this host", async () => {
    expect(await resolveRunCheckout(run({ worktreePath: repoDir }))).toEqual({ cwd: repoDir });
  });

  it("explains a worktree that belongs to a remote worker", async () => {
    const result = await resolveRunCheckout(run({ worktreePath: "/work/run-42" }));
    expect(result).toEqual({ reason: expect.stringContaining("remote worker") });
  });

  it("explains a run that has not checked anything out", async () => {
    expect(await resolveRunCheckout(run({}))).toEqual({
      reason: expect.stringContaining("not checked out"),
    });
  });

  it("has nothing to inspect for a run with no checkout strategy", async () => {
    expect(await resolveRunCheckout(run({ cwdStrategy: "none" }))).toEqual({
      reason: expect.stringContaining("no repository checkout"),
    });
  });
});

describe("porcelain parsers", () => {
  it("reads a rename record's two paths out of --numstat -z", () => {
    expect(parseNumstatZ("1\t2\tplain.txt\u00003\t4\t\u0000old.txt\u0000new.txt\u0000")).toEqual([
      { additions: 1, deletions: 2, path: "plain.txt", oldPath: null },
      { additions: 3, deletions: 4, path: "new.txt", oldPath: "old.txt" },
    ]);
  });

  it("reports a binary file's line counts as unknown rather than zero", () => {
    expect(parseNumstatZ("-\t-\timg.png\u0000")).toEqual([
      { additions: null, deletions: null, path: "img.png", oldPath: null },
    ]);
  });

  it("maps --name-status -z letters, including a scored rename", () => {
    const map = parseNameStatusZ("M\u0000a.txt\u0000D\u0000b.txt\u0000R096\u0000old.txt\u0000new.txt\u0000");
    expect(map.get("a.txt")).toEqual({ status: "modified", oldPath: null });
    expect(map.get("b.txt")).toEqual({ status: "deleted", oldPath: null });
    expect(map.get("new.txt")).toEqual({ status: "renamed", oldPath: "old.txt" });
  });

  it("separates index-staged entries from untracked ones", () => {
    // "R  new.txt\0old.txt" — a staged rename carries its source as the next field.
    const rows = parsePorcelainZ("M  staged.txt\u0000 M dirty.txt\u0000?? new.txt\u0000R  to.txt\u0000from.txt\u0000");
    expect(rows).toEqual([
      { path: "staged.txt", staged: true, untracked: false },
      { path: "dirty.txt", staged: false, untracked: false },
      { path: "new.txt", staged: false, untracked: true },
      { path: "to.txt", staged: true, untracked: false },
    ]);
  });
});
