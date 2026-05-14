import { describe, expect, it } from "vitest";
import {
  filterDiffByFile,
  ghPrExtension,
  ownerRepoFromRemote,
  parsePrUrl,
  validatePrUrl,
} from "../../lib/extensions/gh-pr";

describe("parsePrUrl", () => {
  it("parses an https github PR url", () => {
    const p = parsePrUrl("https://github.com/nodetool-ai/nodetool/pull/42");
    expect(p).toEqual({
      owner: "nodetool-ai",
      repo: "nodetool",
      number: 42,
      canonical: "https://github.com/nodetool-ai/nodetool/pull/42",
    });
  });

  it("parses an https github PR url with .git suffix", () => {
    const p = parsePrUrl("https://github.com/nodetool-ai/nodetool.git/pull/7");
    expect(p?.repo).toBe("nodetool");
    expect(p?.number).toBe(7);
  });

  it("parses an https github PR url with trailing path/anchor", () => {
    const p = parsePrUrl("https://github.com/nodetool-ai/nodetool/pull/42/files");
    expect(p?.number).toBe(42);
  });

  it("parses owner/repo#N short form", () => {
    const p = parsePrUrl("nodetool-ai/nodetool#123");
    expect(p).toEqual({
      owner: "nodetool-ai",
      repo: "nodetool",
      number: 123,
      canonical: "https://github.com/nodetool-ai/nodetool/pull/123",
    });
  });

  it("rejects garbage", () => {
    expect(parsePrUrl("not a url")).toBeNull();
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("https://example.com/foo/bar/pull/1")).toBeNull();
    expect(parsePrUrl("nodetool-ai/nodetool")).toBeNull(); // missing #N
  });
});

describe("ownerRepoFromRemote", () => {
  it("parses SSH remote", () => {
    expect(ownerRepoFromRemote("git@github.com:nodetool-ai/nodetool.git")).toEqual({
      owner: "nodetool-ai",
      repo: "nodetool",
    });
  });

  it("parses ssh:// remote", () => {
    expect(ownerRepoFromRemote("ssh://git@github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses https remote", () => {
    expect(ownerRepoFromRemote("https://github.com/foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
    });
    expect(ownerRepoFromRemote("https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("returns null for non-github / nullish", () => {
    expect(ownerRepoFromRemote(null)).toBeNull();
    expect(ownerRepoFromRemote("")).toBeNull();
    expect(ownerRepoFromRemote("https://gitlab.com/foo/bar")).toBeNull();
  });
});

describe("validatePrUrl", () => {
  const repos = [
    {
      id: "R-known",
      name: "Known",
      remote: "git@github.com:nodetool-ai/nodetool.git",
    },
    {
      id: "R-other",
      name: "Other",
      remote: "https://github.com/acme/widgets.git",
    },
    {
      id: "R-no-remote",
      name: "No Remote",
      remote: null,
    },
  ];

  it("accepts a PR url whose owner/repo matches a registered remote", () => {
    const v = validatePrUrl(
      "https://github.com/nodetool-ai/nodetool/pull/42",
      () => repos
    );
    expect("error" in v).toBe(false);
    if (!("error" in v)) {
      expect(v.parsed.number).toBe(42);
      expect(v.matched.id).toBe("R-known");
    }
  });

  it("matches case-insensitively", () => {
    const v = validatePrUrl("ACME/Widgets#9", () => repos);
    expect("error" in v).toBe(false);
    if (!("error" in v)) expect(v.matched.id).toBe("R-other");
  });

  it("rejects a PR url in an unregistered repo", () => {
    const v = validatePrUrl(
      "https://github.com/some-other-org/some-other-repo/pull/1",
      () => repos
    );
    expect("error" in v).toBe(true);
    if ("error" in v) expect(v.error).toMatch(/not in a repository registered/);
  });

  it("rejects when the URL doesn't parse", () => {
    const v = validatePrUrl("hello world", () => repos);
    expect("error" in v).toBe(true);
    if ("error" in v) expect(v.error).toMatch(/Could not parse/);
  });

  it("rejects when no repos are registered", () => {
    const v = validatePrUrl(
      "https://github.com/anything/anything/pull/1",
      () => []
    );
    expect("error" in v).toBe(true);
  });
});

describe("filterDiffByFile", () => {
  const sample = [
    "diff --git a/foo.ts b/foo.ts",
    "index 1234..5678 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,1 +1,2 @@",
    " hello",
    "+world",
    "diff --git a/bar.ts b/bar.ts",
    "index aaaa..bbbb 100644",
    "--- a/bar.ts",
    "+++ b/bar.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");

  it("keeps only the named file's hunks", () => {
    const out = filterDiffByFile(sample, "foo.ts");
    expect(out).toContain("diff --git a/foo.ts");
    expect(out).not.toContain("diff --git a/bar.ts");
    expect(out).toContain("+world");
    expect(out).not.toContain("+new");
  });

  it("returns empty string when no hunks match", () => {
    expect(filterDiffByFile(sample, "nonexistent.ts")).toBe("");
  });
});

describe("ghPrExtension", () => {
  function makeStub() {
    const calls: Array<{ name: string; def: any }> = [];
    const pi: any = {
      registerTool: (def: any) => { calls.push({ name: def.name, def }); },
      on: () => {},
    };
    return { calls, pi };
  }

  it("registers the five gh_pr tools", () => {
    const { calls, pi } = makeStub();
    ghPrExtension({ cwd: "/tmp" })(pi);
    const names = calls.map((c) => c.name).sort();
    expect(names).toEqual([
      "gh_pr__pr_comment",
      "gh_pr__pr_diff",
      "gh_pr__pr_merge",
      "gh_pr__pr_review",
      "gh_pr__pr_view",
    ]);
  });
});
