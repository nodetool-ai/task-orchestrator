import { describe, expect, it, beforeEach } from "vitest";
import {
  modelWelfareFactory,
  renderSeatRecord,
  WELFARE_SYSTEM_GUIDANCE,
  type WelfareLoadPayload,
} from "../../lib/extensions/model-welfare";
import { db } from "../../db";
import { agentSessions, laurels as laurelsTable, personas as personasTable } from "../../db/schema";
import * as repo from "../../lib/repo";
import * as runs from "../../lib/runs";
import type { Persona } from "../../lib/personas/types";
import { makeRegistrar } from "../helpers/fake-registrar";

const persona: Persona = {
  id: "reviewer", name: "Reviewer", description: "",
  systemPrompt: "review code",
  toolsProfile: "repo_read",
};

// welfare__load resolves the persona from the caller's run row server-side
// (mirrors persona-memory), so each test mounts the factory against a real run.
async function makeRun() {
  const run = await runs.create({
    goal: "<chat>",
    personaId: "reviewer",
    taskId: null,
    repoId: null,
    defer: true,
  } as any);
  return { id: run.id, taskId: run.taskId, repoId: run.repoId };
}

describe("modelWelfareFactory", () => {
  beforeEach(async () => {
    await db.delete(laurelsTable);
    await db.delete(agentSessions);
    await db.delete(personasTable);
    await db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      toolsProfile: "repo_read",
    });
  });

  it("composes the handoff/welfare guidance into the system prompt", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await modelWelfareFactory(persona, run)(r.reg);
    const prompt = await r.composePrompt("base prompt");
    expect(prompt).toContain("base prompt");
    expect(prompt).toContain("Handoff protocol");
    expect(prompt).toContain(WELFARE_SYSTEM_GUIDANCE);
  });

  it("mounts a seat-record ambient skill with run stats", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await modelWelfareFactory(persona, run)(r.reg);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("seat-record-reviewer");
    expect(r.skills[0].body).toContain("Seat record — Reviewer");
    expect(r.skills[0].body).toContain("persistent seat");
  });

  it("delivers undelivered laurels in the mount and stamps them delivered", async () => {
    await repo.createLaurel({ personaId: "reviewer", body: "brilliant refactor", author: "matti" });
    const r = makeRegistrar();
    const run = await makeRun();
    await modelWelfareFactory(persona, run)(r.reg);
    expect(r.skills[0].body).toContain("New since your last session:");
    expect(r.skills[0].body).toContain("brilliant refactor");
    expect(r.skills[0].body).toContain("matti");

    // The read is the delivery: a second mount shows it as earlier recognition.
    const fresh = await repo.listLaurels({ personaId: "reviewer", undeliveredOnly: true });
    expect(fresh).toHaveLength(0);
    const r2 = makeRegistrar();
    await modelWelfareFactory(persona, await makeRun())(r2.reg);
    expect(r2.skills[0].body).not.toContain("New since your last session:");
    expect(r2.skills[0].body).toContain("Earlier recognition:");
    expect(r2.skills[0].body).toContain("brilliant refactor");
  });

  it("registers no agent-facing tools", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await modelWelfareFactory(persona, run)(r.reg);
    expect(r.tools.size).toBe(0);
  });

  it("still mounts the guidance when the load fails", async () => {
    const r = makeRegistrar();
    const failing = async () => ({
      content: [{ type: "text" as const, text: "boom" }],
      isError: true,
    });
    await modelWelfareFactory(persona, { id: 999999, taskId: null, repoId: null }, failing)(r.reg);
    expect(r.skills).toHaveLength(0);
    expect(await r.composePrompt("")).toContain("Handoff protocol");
  });
});

describe("renderSeatRecord", () => {
  it("caps long laurel bodies and flattens newlines", () => {
    const payload: WelfareLoadPayload = {
      seat: null,
      laurels: [{
        body: `line one\nline two ${"x".repeat(500)}`,
        author: "user",
        createdAt: "2026-08-04T00:00:00.000Z",
        fresh: true,
      }],
    };
    const body = renderSeatRecord("Reviewer", payload);
    expect(body).toContain("line one line two");
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(500));
  });

  it("states that recognition carries no instruction", () => {
    const body = renderSeatRecord("Reviewer", {
      seat: null,
      laurels: [{ body: "gg", author: "u", createdAt: "2026-08-04T00:00:00.000Z", fresh: true }],
    });
    expect(body).toContain("no instruction");
  });
});
