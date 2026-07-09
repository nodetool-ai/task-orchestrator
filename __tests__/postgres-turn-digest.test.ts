import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
let contextAtCompletion: any;

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({ provider, id }),
    refresh: vi.fn(),
    completeSimple,
  }),
}));

import { runPostgresTurn } from "../lib/agent-backend/postgres-turn";
import type { PostgresMessageRow, RunTurnArgs } from "../lib/agent-backend/types";

describe("postgres-mode event digest persistence", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    completeSimple.mockImplementation(async (_model, context) => {
      contextAtCompletion = structuredClone(context);
      return {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      };
    });
  });

  it("sends the digest in the current prompt but embeds only raw user text", async () => {
    const rawUserText = "Please check the child run.";
    const digestText = "[event digest]\nchild run 42 completed";
    const prompt = `${digestText}\n\n${rawUserText}`;
    const rows: PostgresMessageRow[] = [{
      id: 7,
      role: "user",
      content: [{ type: "text", text: rawUserText }],
      createdAt: 1_700_000_000_000,
    }];
    let annotated: PostgresMessageRow["content"] | null = null;

    await runPostgresTurn({
      cwd: "/tmp",
      model: { provider: "anthropic", id: "test-model" },
      extensions: [],
      resumeToken: null,
      abort: new AbortController(),
      prompt,
      contextSource: {
        kind: "postgres",
        runId: 42,
        goal: "<chat>",
        ephemeralInput: false,
        rawUserText,
        loadMessages: async () => rows,
        // The production callback serializes immediately; clone here so the
        // subsequent live-context override cannot mutate our persisted sample.
        annotateMessage: async (_id, content) => { annotated = structuredClone(content); },
      },
      onEvent: vi.fn(),
    } satisfies RunTurnArgs);

    const persistedMessage = (annotated![0] as any).piMessage;
    expect(persistedMessage.content).toBe(rawUserText);
    expect(JSON.stringify(persistedMessage)).not.toContain(digestText);

    expect(contextAtCompletion.messages.at(-1)?.content).toBe(prompt);
  });
});
