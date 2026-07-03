import { beforeEach, describe, expect, it } from "vitest";
import { ne, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "../db";
import {
  acceptanceCriteria,
  agentMessages,
  agentSessions,
  attachments,
  plans,
  repositories,
  taskNotes,
  tasks,
} from "../db/schema";
import * as repo from "../lib/repo";
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { parseAttachmentUpload } from "../lib/attachment-upload";
import { GET as downloadGet } from "../app/api/attachments/[id]/route";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function findTool(name: string, ctx?: { defaultTaskId?: string; defaultPlanId?: string }) {
  const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (params: Record<string, unknown>) =>
    tool.execute(params, { author: "tester", ...ctx });
}

beforeEach(async () => {
  await db.delete(agentMessages);
  await db.delete(agentSessions);
  await db.delete(attachments);
  await db.delete(acceptanceCriteria);
  await db.delete(taskNotes);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

async function makeTask() {
  const plan = await repo.createPlan({ title: "Attach Plan", date: "2026-05-28" });
  const task = await repo.createTask({ planId: plan.id, title: "Attach Task" });
  return { plan, task };
}

describe("repo attachments", () => {
  it("adds an image attachment to a task and derives kind", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "shot.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    expect(meta.kind).toBe("image");
    expect(meta.sizeBytes).toBe(PNG.length);
    expect(meta.taskId).toBe(task.id);
    expect(meta.planId).toBeNull();
    expect((await repo.getTask(task.id))!.attachments).toHaveLength(1);
  });

  it("derives 'artifact' kind for non-image mime types", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "log.txt",
      mimeType: "text/plain",
      content: Buffer.from("hello"),
      author: "alice",
    });
    expect(meta.kind).toBe("artifact");
  });

  it("attaches to a plan and hydrates onto PlanFull", async () => {
    const { plan } = await makeTask();
    await repo.addAttachment({
      planId: plan.id,
      filename: "spec.md",
      mimeType: "text/markdown",
      content: Buffer.from("# spec"),
      author: "alice",
    });
    expect((await repo.getPlan(plan.id))!.attachments).toHaveLength(1);
    expect((await repo.listPlans()).find((p) => p.id === plan.id)!.attachments).toHaveLength(1);
  });

  it("hydrates attachments via the batched listTasks path", async () => {
    const { task } = await makeTask();
    await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const listed = await repo.listTasks({ planId: task.planId });
    expect(listed[0].attachments).toHaveLength(1);
  });

  it("rejects an attachment bound to both a plan and a task", async () => {
    const { plan, task } = await makeTask();
    await expect(
      repo.addAttachment({
        planId: plan.id,
        taskId: task.id,
        filename: "x",
        mimeType: "text/plain",
        content: Buffer.from("x"),
        author: "a",
      })
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects an attachment bound to neither", async () => {
    await expect(
      repo.addAttachment({
        filename: "x",
        mimeType: "text/plain",
        content: Buffer.from("x"),
        author: "a",
      })
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects empty content and unknown owner", async () => {
    const { task } = await makeTask();
    await expect(
      repo.addAttachment({
        taskId: task.id,
        filename: "x",
        mimeType: "text/plain",
        content: Buffer.alloc(0),
        author: "a",
      })
    ).rejects.toThrow(/empty/);
    await expect(
      repo.addAttachment({
        taskId: "T-20260101-9999",
        filename: "x",
        mimeType: "text/plain",
        content: Buffer.from("x"),
        author: "a",
      })
    ).rejects.toThrow(/not found/);
  });

  it("enforces the size cap", async () => {
    const { task } = await makeTask();
    const tooBig = Buffer.alloc(repo.MAX_ATTACHMENT_BYTES + 1);
    await expect(
      repo.addAttachment({
        taskId: task.id,
        filename: "big.bin",
        mimeType: "application/octet-stream",
        content: tooBig,
        author: "a",
      })
    ).rejects.toThrow(/too large/);
  });

  it("returns content via getAttachment and meta-only via getAttachmentMeta", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const full = (await repo.getAttachment(meta.id))!;
    expect(Buffer.compare(full.content, PNG)).toBe(0);
    const metaOnly = (await repo.getAttachmentMeta(meta.id))!;
    expect((metaOnly as unknown as Record<string, unknown>).content).toBeUndefined();
  });

  it("deletes an attachment", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    await repo.deleteAttachment(meta.id);
    expect(await repo.getAttachment(meta.id)).toBeNull();
  });

  it("cascades attachment deletion when the task is deleted", async () => {
    const { task } = await makeTask();
    await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    await repo.deleteTask(task.id);
    const remaining = await db
      .select()
      .from(attachments)
      .where(eq(attachments.taskId, task.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("parseAttachmentUpload", () => {
  it("parses a JSON base64 body", async () => {
    const req = new Request("http://x/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "note.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("hi there").toString("base64"),
      }),
    });
    const parsed = await parseAttachmentUpload(req);
    expect(parsed.filename).toBe("note.txt");
    expect(parsed.mimeType).toBe("text/plain");
    expect(parsed.content.toString("utf8")).toBe("hi there");
  });

  it("parses a multipart/form-data body", async () => {
    const form = new FormData();
    form.append("file", new File([PNG], "shot.png", { type: "image/png" }));
    const req = new Request("http://x/upload", { method: "POST", body: form });
    const parsed = await parseAttachmentUpload(req);
    expect(parsed.filename).toBe("shot.png");
    expect(parsed.mimeType).toBe("image/png");
    expect(Buffer.compare(parsed.content, PNG)).toBe(0);
  });

  it("rejects an unsupported content-type", async () => {
    const req = new Request("http://x/upload", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "raw",
    });
    await expect(parseAttachmentUpload(req)).rejects.toThrow(/content-type/i);
  });
});

describe("attachment download route", () => {
  it("serves the raw bytes with the right headers", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "shot.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const res = await downloadGet(
      new NextRequest(`http://localhost/api/attachments/${meta.id}`),
      { params: Promise.resolve({ id: String(meta.id) }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
    const body = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(body, PNG)).toBe(0);
  });

  it("forces download with ?download=1", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "shot.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const res = await downloadGet(
      new NextRequest(`http://localhost/api/attachments/${meta.id}?download=1`),
      { params: Promise.resolve({ id: String(meta.id) }) }
    );
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("404s for a missing attachment", async () => {
    const res = await downloadGet(
      new NextRequest("http://localhost/api/attachments/999999"),
      { params: Promise.resolve({ id: "999999" }) }
    );
    expect(res.status).toBe(404);
  });
});

describe("orchestrator attachment tools", () => {
  it("get_attachment returns a viewable image block", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "shot.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const result = await findTool("get_attachment")({ id: meta.id });
    expect(result.isError).toBeFalsy();
    const image = result.content.find((c) => c.type === "image") as
      | { type: "image"; data: string; mimeType: string }
      | undefined;
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe("image/png");
    expect(Buffer.from(image!.data, "base64").equals(PNG)).toBe(true);
  });

  it("get_attachment decodes textual artifacts as text", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "log.txt",
      mimeType: "text/plain",
      content: Buffer.from("build failed at step 3"),
      author: "alice",
    });
    const result = await findTool("get_attachment")({ id: meta.id });
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("build failed at step 3");
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("add_attachment with text creates an artifact on the scoped task", async () => {
    const { task } = await makeTask();
    const result = await findTool("add_attachment", { defaultTaskId: task.id })({
      filename: "report.md",
      text: "# Report\nall good",
    });
    expect(result.isError).toBeFalsy();
    const list = await repo.listAttachments({ taskId: task.id });
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("report.md");
    expect(list[0].kind).toBe("artifact");
  });

  it("add_attachment rejects both text and content_base64", async () => {
    const { task } = await makeTask();
    const result = await findTool("add_attachment", { defaultTaskId: task.id })({
      filename: "x",
      text: "a",
      content_base64: Buffer.from("b").toString("base64"),
    });
    expect(result.isError).toBe(true);
  });

  it("list_attachments defaults to the scoped task", async () => {
    const { task } = await makeTask();
    await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const result = await findTool("list_attachments", { defaultTaskId: task.id })({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].filename).toBe("a.png");
  });

  it("delete_attachment removes it", async () => {
    const { task } = await makeTask();
    const meta = await repo.addAttachment({
      taskId: task.id,
      filename: "a.png",
      mimeType: "image/png",
      content: PNG,
      author: "alice",
    });
    const result = await findTool("delete_attachment")({ id: meta.id });
    expect(result.isError).toBeFalsy();
    expect(await repo.getAttachmentMeta(meta.id)).toBeNull();
  });
});
