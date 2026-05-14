import { describe, expect, it } from "vitest";
import { trimLog, MAX_LOG_LINES, MAX_LOG_BYTES } from "../../lib/extensions/gh-ci";
import { validatePrUrl } from "../../lib/gh-url";
import { ghCiExtension } from "../../lib/extensions/gh-ci";

// ──────────────────────────────────────────────────────────
// Registration test
// ──────────────────────────────────────────────────────────

function makeStub() {
  const calls: Array<{ name: string; def: any }> = [];
  const pi: any = {
    registerTool: (def: any) => { calls.push({ name: def.name, def }); },
    on: () => {},
  };
  return { calls, pi };
}

describe("ghCiExtension", () => {
  it("registers expected gh_ci tools", () => {
    const { calls, pi } = makeStub();
    ghCiExtension({ cwd: "/tmp" })(pi);
    const names = calls.map((c) => c.name).sort();
    expect(names).toEqual([
      "gh_ci__ci_logs",
      "gh_ci__ci_rerun",
      "gh_ci__ci_runs",
    ]);
  });

  it("each tool has a label", () => {
    const { calls, pi } = makeStub();
    ghCiExtension({ cwd: "/tmp" })(pi);
    for (const { def } of calls) {
      expect(typeof def.label).toBe("string");
      expect(def.label.length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────
// URL validation gate
// ──────────────────────────────────────────────────────────

describe("gh_ci: URL validation gate", () => {
  const repos = [
    {
      id: "R-known",
      name: "Known",
      remote: "git@github.com:nodetool-ai/nodetool.git",
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

  it("rejects a PR url in an unknown repo", () => {
    const v = validatePrUrl(
      "https://github.com/some-other-org/some-other-repo/pull/1",
      () => repos
    );
    expect("error" in v).toBe(true);
    if ("error" in v) expect(v.error).toMatch(/not in a repository registered/);
  });

  it("rejects garbage URLs", () => {
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

// ──────────────────────────────────────────────────────────
// trimLog
// ──────────────────────────────────────────────────────────

describe("trimLog", () => {
  it("returns the input unchanged when under both caps", () => {
    const small = "line1\nline2\nline3";
    expect(trimLog(small)).toBe(small);
  });

  it("returns empty string for empty input", () => {
    expect(trimLog("")).toBe("");
  });

  it("trims to the last N lines when input exceeds maxLines", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 1200; i += 1) lines.push(`line ${i}`);
    const out = trimLog(lines.join("\n"));
    // Header indicates truncation
    expect(out).toMatch(/^\[trimmed: showing last \d+ of 1200 lines; \d+ dropped\]/);
    // Last line preserved
    expect(out.endsWith("line 1200")).toBe(true);
    // Earliest lines dropped
    expect(out).not.toContain("line 1\n");
    // Body line count == MAX_LOG_LINES (default)
    const body = out.split("\n").slice(1).join("\n");
    expect(body.split("\n").length).toBe(MAX_LOG_LINES);
  });

  it("respects custom maxLines option", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const out = trimLog(lines.join("\n"), { maxLines: 10, maxBytes: 100_000 });
    expect(out).toMatch(/^\[trimmed: showing last 10 of 100 lines; 90 dropped\]/);
    expect(out.endsWith("l99")).toBe(true);
    const body = out.split("\n").slice(1);
    expect(body.length).toBe(10);
    expect(body[0]).toBe("l90");
  });

  it("further trims when the line-tail still exceeds maxBytes", () => {
    // 600 lines * ~200 bytes each = 120KB; default 500-line tail still ~100KB,
    // which exceeds 50KB → byte-trim should drop more lines.
    const fat = "x".repeat(200);
    const lines: string[] = [];
    for (let i = 0; i < 600; i += 1) lines.push(`${i}:${fat}`);
    const raw = lines.join("\n");
    const out = trimLog(raw);
    // Result must fit under MAX_LOG_BYTES + a small allowance for the header.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_LOG_BYTES + 200);
    // Still flagged as trimmed.
    expect(out.startsWith("[trimmed:")).toBe(true);
    // The very last record is the most recent one.
    expect(out.endsWith(`599:${fat}`)).toBe(true);
  });

  it("handles pathological single-huge-line input by slicing trailing bytes", () => {
    const huge = "y".repeat(MAX_LOG_BYTES * 3);
    const out = trimLog(huge);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_LOG_BYTES + 200);
    // Should still end with the trailing portion of the input.
    expect(out.endsWith("y")).toBe(true);
  });

  it("default trim caps total output at roughly MAX_LOG_BYTES", () => {
    // 10k lines of moderate length → well over 50KB → result must fit.
    const lines = Array.from({ length: 10_000 }, (_, i) => `log line number ${i} with some padding`);
    const out = trimLog(lines.join("\n"));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_LOG_BYTES + 200);
  });
});
