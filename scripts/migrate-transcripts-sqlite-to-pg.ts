#!/usr/bin/env node
// scripts/migrate-transcripts-sqlite-to-pg.ts
//
// Migrate the historical run transcripts the config ETL (migrate-sqlite-to-pg.ts)
// intentionally SKIPPED: agent_runs / agent_messages / agent_events /
// channel_threads. Imports with ORIGINAL ids (messages/events reference run_id),
// NEUTRALIZES any non-terminal run status to 'closed' so the reconcile/pump never
// tries to auto-execute an archived run, NULLS any run FK that no longer resolves,
// restores tasks.attached_run_id, and resyncs the serial sequences. Idempotent
// (ON CONFLICT DO NOTHING) — but delete any colliding post-cutover run ids first.
//
//   SOURCE_SQLITE_DB=/var/lib/task-orchestrator/data.db \
//   DATABASE_URL=postgres://user:pass@host:5432/db \
//   npx tsx scripts/migrate-transcripts-sqlite-to-pg.ts [--dry-run]

import { config } from "dotenv";
config({ path: ".env.local" });

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { db, sql, schema } from "../db";

const SOURCE = process.env.SOURCE_SQLITE_DB || "/var/lib/task-orchestrator/data.db";
const DRY = process.argv.includes("--dry-run");
const toDate = (ms: unknown): Date | null => (ms == null ? null : new Date(Number(ms)));
const TERMINAL = new Set(["completed", "failed", "cancelled", "closed", "budget_exhausted"]);

type Row = Record<string, any>;

async function idSet(table: any, col: any): Promise<Set<unknown>> {
  const rows = (await db.select({ id: col }).from(table)) as Row[];
  return new Set(rows.map((r) => r.id));
}

async function chunkInsert(table: any, rows: Row[], size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await db.insert(table).values(rows.slice(i, i + size)).onConflictDoNothing();
  }
}

async function main(): Promise<void> {
  const sqlite = new Database(SOURCE, { readonly: true });
  const read = (t: string): Row[] => {
    try {
      return sqlite.prepare(`SELECT * FROM ${t}`).all() as Row[];
    } catch {
      return [];
    }
  };
  const runs = read("agent_runs");
  const msgs = read("agent_messages");
  const evts = read("agent_events");
  const threads = read("channel_threads");
  const taskLinks = sqlite
    .prepare("SELECT id, attached_run_id FROM tasks WHERE attached_run_id IS NOT NULL")
    .all() as Row[];

  console.log(`transcripts: ${SOURCE} -> ${process.env.DATABASE_URL}${DRY ? "  [DRY RUN]" : ""}`);
  console.log(
    `  source rows: runs=${runs.length} messages=${msgs.length} events=${evts.length} threads=${threads.length} taskLinks=${taskLinks.length}`
  );

  if (DRY) {
    const neutralized = runs.filter((r) => !TERMINAL.has(r.status)).length;
    console.log(`  runs whose non-terminal status would become 'closed': ${neutralized}`);
    const collide = await idSet(schema.agentSessions, schema.agentSessions.id);
    const clashes = runs.filter((r) => collide.has(r.id)).map((r) => r.id);
    console.log(`  id collisions with existing PG agent_runs: [${clashes.join(",")}] (delete these first)`);
    console.log("  dry run — nothing written.");
    sqlite.close();
    process.exit(0);
  }

  // Valid FK targets already in PG (config ETL migrated them).
  const [vTasks, vPlans, vRepos, vUsers, vPersonas] = await Promise.all([
    idSet(schema.tasks, schema.tasks.id),
    idSet(schema.plans, schema.plans.id),
    idSet(schema.repositories, schema.repositories.id),
    idSet(schema.users, schema.users.id),
    idSet(schema.personas, schema.personas.id),
  ]);

  const runRows: Row[] = runs.map((r) => ({
    id: r.id,
    taskId: r.task_id && vTasks.has(r.task_id) ? r.task_id : null,
    planId: r.plan_id && vPlans.has(r.plan_id) ? r.plan_id : null,
    repoId: r.repo_id && vRepos.has(r.repo_id) ? r.repo_id : null,
    userId: r.user_id && vUsers.has(r.user_id) ? r.user_id : null,
    personaId: r.persona_id && vPersonas.has(r.persona_id) ? r.persona_id : null,
    status: TERMINAL.has(r.status) ? r.status : "closed",
    model: r.model ?? null,
    branch: r.branch ?? null,
    worktreePath: r.worktree_path ?? null,
    prUrl: r.pr_url ?? null,
    error: r.error ?? null,
    totalCostUsd: r.total_cost_usd ?? null,
    inputTokens: r.input_tokens ?? null,
    outputTokens: r.output_tokens ?? null,
    sdkSessionId: r.sdk_session_id ?? null,
    resumeOf: r.resume_of ?? null,
    goal: r.goal ?? "<implement>",
    thinkingLevel: r.thinking_level ?? null,
    toolsProfile: r.tools_profile ?? "orchestrator,repo_write",
    cwdStrategy: r.cwd_strategy ?? "worktree",
    parentRunId: r.parent_run_id ?? null,
    budgetMaxTurns: r.budget_max_turns ?? null,
    budgetMaxUsd: r.budget_max_usd ?? null,
    budgetMaxSeconds: r.budget_max_seconds ?? null,
    outcome: r.outcome ?? null,
    title: r.title ?? null,
    legacyChatId: r.legacy_chat_id ?? null,
    planningStage: r.planning_stage ?? null,
    startedAt: toDate(r.started_at) ?? new Date(),
    completedAt: toDate(r.completed_at),
    workerScope: null,
    cancelRequested: null,
  }));
  await chunkInsert(schema.agentSessions, runRows);
  console.log(`  agent_runs: ${runRows.length}`);

  const runIds = new Set(runRows.map((r) => r.id));
  await chunkInsert(
    schema.agentMessages,
    msgs
      .filter((m) => runIds.has(m.run_id))
      .map((m) => ({ id: m.id, runId: m.run_id, role: m.role, content: m.content ?? "[]", createdAt: toDate(m.created_at) ?? new Date() }))
  );
  console.log(`  agent_messages: ${msgs.filter((m) => runIds.has(m.run_id)).length}`);

  await chunkInsert(
    schema.agentEvents,
    evts
      .filter((e) => runIds.has(e.run_id))
      .map((e) => ({ id: e.id, sessionId: e.run_id, type: e.type, payload: e.payload ?? "{}", createdAt: toDate(e.created_at) ?? new Date() }))
  );
  console.log(`  agent_events: ${evts.filter((e) => runIds.has(e.run_id)).length}`);

  const thRows = threads
    .filter((t) => runIds.has(t.run_id))
    .map((t) => ({ id: t.id, channel: t.channel, externalId: t.external_id, runId: t.run_id, createdAt: toDate(t.created_at) ?? new Date() }));
  if (thRows.length) await db.insert(schema.channelThreads).values(thRows).onConflictDoNothing();
  console.log(`  channel_threads: ${thRows.length}`);

  let restored = 0;
  for (const tl of taskLinks) {
    if (!runIds.has(tl.attached_run_id)) continue;
    await db.update(schema.tasks).set({ attachedRunId: tl.attached_run_id }).where(eq(schema.tasks.id, tl.id));
    restored++;
  }
  console.log(`  tasks.attached_run_id restored: ${restored}`);

  for (const t of ["agent_runs", "agent_messages", "agent_events", "channel_threads"]) {
    await sql.unsafe(
      `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${t}), 1))`
    );
  }
  console.log("sequences resynced. done.");
  sqlite.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
