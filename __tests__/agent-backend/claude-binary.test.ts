// __tests__/agent-backend/claude-binary.test.ts
//
// TASK_ORCH_CLAUDE_BINARY is explicit-only (no PATH probing) and must fail
// loud at resolution time — never as the SDK's opaque spawn error mid-run.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClaudeBinary } from "../../lib/agent-backend/claude-binary";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  savedEnv = process.env.TASK_ORCH_CLAUDE_BINARY;
  delete process.env.TASK_ORCH_CLAUDE_BINARY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv == null) delete process.env.TASK_ORCH_CLAUDE_BINARY;
  else process.env.TASK_ORCH_CLAUDE_BINARY = savedEnv;
});

function fakeBinary(mode: number): string {
  const p = join(dir, "claude");
  writeFileSync(p, "#!/bin/sh\necho fake-claude 1.0.0\n");
  chmodSync(p, mode);
  return p;
}

describe("resolveClaudeBinary", () => {
  it("returns undefined when TASK_ORCH_CLAUDE_BINARY is unset (SDK bundled binary)", () => {
    expect(resolveClaudeBinary()).toBeUndefined();
  });

  it("returns the path when it points at an executable file", () => {
    const p = fakeBinary(0o755);
    process.env.TASK_ORCH_CLAUDE_BINARY = p;
    expect(resolveClaudeBinary()).toBe(p);
  });

  it("throws naming the path and env var when the file is missing", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = join(dir, "no-such-claude");
    expect(() => resolveClaudeBinary()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
    expect(() => resolveClaudeBinary()).toThrow(/no-such-claude/);
  });

  it("throws when the file exists but is not executable", () => {
    const p = fakeBinary(0o644);
    process.env.TASK_ORCH_CLAUDE_BINARY = p;
    expect(() => resolveClaudeBinary()).toThrow(/not executable|missing or not executable/);
  });

  it("throws when the path is a directory", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = dir;
    expect(() => resolveClaudeBinary()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
  });
});
