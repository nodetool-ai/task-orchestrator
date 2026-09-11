import { describe, expect, it } from "vitest";
import { boundResumeTranscript, RESUME_SNAPSHOT_BYTES } from "../lib/worker-channel/resume-transcript";
import type { RunStart } from "../lib/worker-channel/protocol";
import { MAX_JSON_FRAME_BYTES } from "../lib/worker-channel/protocol";

function snapshot(): RunStart {
  return {
    mode: "resume",
    run: { id: 219, sdkSessionId: "existing-session" },
    task: null,
    plan: null,
    persona: { id: "concierge" },
    repository: { id: "R-default" },
    transcript: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: i % 2 ? "agent" as const : "user" as const,
      content: [{ type: "text", text: "🧩\"\n".repeat(15_000) }],
    })),
    pendingInput: [{ id: 21, role: "user", content: [{ type: "text", text: "whats status" }] }],
    turnId: "claimed-turn",
    inputManifest: [{ id: "input-21", inputSeq: 21, messageId: 21, kind: "user" }],
    inboxDigest: null,
    memoryContext: "",
    policy: { allowedTools: [], maxTurns: null, deadline: null },
  };
}

describe("resume transcript byte budget", () => {
  it("bounds UTF-8 JSON bytes, keeping the recent tail and exact pending manifest", () => {
    const start = snapshot();
    const original = structuredClone(start);
    const bounded = boundResumeTranscript(start);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(RESUME_SNAPSHOT_BYTES);
    expect(bounded.transcript).toEqual(start.transcript.slice(bounded.transcriptOmittedMessages));
    expect(bounded.transcript.at(-1)).toEqual(start.transcript.at(-1));
    expect(bounded.pendingInput).toBe(start.pendingInput);
    expect(bounded.inputManifest).toBe(start.inputManifest);
    expect(bounded.turnId).toBe(start.turnId);
    expect(bounded.run.sdkSessionId).toBe("existing-session");
    expect(start).toEqual(original);
    expect(boundResumeTranscript(start)).toEqual(bounded);
    expect(boundResumeTranscript(bounded)).toBe(bounded);
  });

  it("keeps the last agent cursor and all trailing legacy input", () => {
    const start = snapshot();
    start.transcript.push({ id: 22, role: "user", content: [{ type: "text", text: "still waiting" }] });
    const bounded = boundResumeTranscript(start);
    expect(bounded.transcript.slice(-2)).toEqual(start.transcript.slice(-2));
  });

  it("does not trim fresh starts and does bound recovery without a backend session", () => {
    const start = snapshot();
    start.mode = "start";
    expect(boundResumeTranscript(start)).toBe(start);
    start.mode = "resume";
    start.run.sdkSessionId = null;
    const bounded = boundResumeTranscript(start);
    expect(bounded.transcriptOmittedMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(RESUME_SNAPSHOT_BYTES);
    expect(bounded.pendingInput).toBe(start.pendingInput);
  });

  it("never drops oversized pending input or unprocessed first-turn history to fit", () => {
    const start = snapshot();
    start.pendingInput[0].content = [{ type: "text", text: "x".repeat(RESUME_SNAPSHOT_BYTES * 2) }];
    expect(boundResumeTranscript(start)).toBe(start);
    start.pendingInput = [];
    start.transcript = start.transcript.filter(message => message.role === "user");
    expect(boundResumeTranscript(start)).toBe(start);
  });

  it("makes room for pending input larger than the soft history budget", () => {
    const start = snapshot();
    start.pendingInput[0].content = [{ type: "text", text: "x".repeat(600_000) }];
    const bounded = boundResumeTranscript(start);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(MAX_JSON_FRAME_BYTES - 4096);
    expect(bounded.pendingInput).toBe(start.pendingInput);
    expect(bounded.transcript).toEqual(start.transcript.slice(-1));
  });

  it("leaves small snapshots unchanged", () => {
    const start = snapshot();
    start.transcript = start.transcript.slice(-1);
    expect(boundResumeTranscript(start)).toBe(start);
  });
});
