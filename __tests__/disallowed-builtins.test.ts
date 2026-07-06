import { describe, it, expect } from "vitest";
import { disallowedBuiltinsFor } from "../lib/builtin-tools";

describe("disallowedBuiltinsFor", () => {
  it("denies the whole fs/shell family when cwd_strategy is none, regardless of repo-write", () => {
    expect(disallowedBuiltinsFor("none", true)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "LS",
    ]);
    expect(disallowedBuiltinsFor("none", false)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "LS",
    ]);
  });

  it("denies nothing for a repo-write worktree checkout", () => {
    expect(disallowedBuiltinsFor("worktree", true)).toEqual([]);
  });

  it("denies nothing for a repo-write repo checkout", () => {
    expect(disallowedBuiltinsFor("repo", true)).toEqual([]);
  });

  it("denies the mutating file tools for a read-only checkout", () => {
    expect(disallowedBuiltinsFor("worktree_at_pr", false)).toEqual(["Write", "Edit"]);
    expect(disallowedBuiltinsFor("repo", false)).toEqual(["Write", "Edit"]);
  });
});
