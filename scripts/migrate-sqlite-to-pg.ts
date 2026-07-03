#!/usr/bin/env node
// scripts/migrate-sqlite-to-pg.ts
//
// One-shot ETL: copy the durable *config* tables from the legacy SQLite DB into
// Postgres. Historical run transcripts (agent_runs / agent_messages /
// agent_events / channel_threads) are intentionally DROPPED — they are large and
// not needed post-cutover (see the migration design doc).
//
//   SOURCE_SQLITE_DB=/var/lib/task-orchestrator/data.db \
//   DATABASE_URL=postgres://user:pass@host:5432/task_orchestrator \
//   npx tsx scripts/migrate-sqlite-to-pg.ts [--dry-run]
//
// Idempotent: every insert uses ON CONFLICT DO NOTHING, so re-running only fills
// gaps. Serial-id sequences are re-synced at the end so future inserts don't
// collide with migrated ids.

import { config } from "dotenv";
config({ path: ".env.local" });

import Database from "better-sqlite3";
import { db, initDb, sql, schema } from "../db";

const SOURCE = process.env.SOURCE_SQLITE_DB || "/var/lib/task-orchestrator/data.db";
const DRY = process.argv.includes("--dry-run");

// epoch-ms integer (legacy SQLite) -> Date (pg timestamptz). Null-safe.
const toDate = (ms: number | null | undefined): Date | null =>
  ms == null ? null : new Date(Number(ms));

type Row = Record<string, any>;
function read(sqlite: Database.Database, table: string): Row[] {
  try {
    return sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } catch (err) {
    console.warn(`  (source table ${table} unreadable: ${(err as Error).message})`);
    return [];
  }
}

async function insert<T extends { onConflictDoNothing: () => any }>(
  label: string,
  rows: unknown[],
  build: () => T
): Promise<number> {
  if (rows.length === 0) {
    console.log(`  ${label}: 0`);
    return 0;
  }
  if (DRY) {
    console.log(`  ${label}: ${rows.length} (dry-run, not written)`);
    return rows.length;
  }
  await build().onConflictDoNothing();
  console.log(`  ${label}: ${rows.length}`);
  return rows.length;
}

async function main() {
  console.log(`ETL: ${SOURCE} -> ${process.env.DATABASE_URL}${DRY ? "  [DRY RUN]" : ""}`);
  await initDb(); // ensure the target schema exists

  const s = new Database(SOURCE, { readonly: true });

  // FK order: repositories/users/personas first, then plans, then tasks, then
  // their children, then api_tokens / persona_memories.
  const repositories = read(s, "repositories");
  await insert("repositories", repositories, () =>
    db.insert(schema.repositories).values(
      repositories.map((r) => ({
        id: r.id,
        name: r.name,
        remote: r.remote ?? null,
        localPath: r.local_path ?? null,
        defaultBranch: r.default_branch ?? "main",
        description: r.description ?? "",
        createdAt: toDate(r.created_at) ?? undefined,
        updatedAt: toDate(r.updated_at) ?? undefined,
      }))
    )
  );

  const users = read(s, "users");
  await insert("users", users, () =>
    db.insert(schema.users).values(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        passwordHash: u.password_hash,
        createdAt: toDate(u.created_at) ?? undefined,
      }))
    )
  );

  const personas = read(s, "personas");
  await insert("personas", personas, () =>
    db.insert(schema.personas).values(
      personas.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        systemPrompt: p.system_prompt,
        thinkingLevel: p.thinking_level ?? null,
        toolsProfile: p.tools_profile,
        skillPaths: p.skill_paths ?? "[]",
        budgetMaxTurns: p.budget_max_turns ?? null,
        budgetMaxSeconds: p.budget_max_seconds ?? null,
        createdAt: toDate(p.created_at) ?? undefined,
        updatedAt: toDate(p.updated_at) ?? undefined,
      }))
    )
  );

  const plans = read(s, "plans");
  await insert("plans", plans, () =>
    db.insert(schema.plans).values(
      plans.map((p) => ({
        id: p.id,
        title: p.title,
        state: p.state ?? "draft",
        owner: p.owner ?? null,
        body: p.body ?? "",
        tags: p.tags ?? "[]",
        createdAt: toDate(p.created_at) ?? undefined,
        updatedAt: toDate(p.updated_at) ?? undefined,
      }))
    )
  );

  const planRepositories = read(s, "plan_repositories");
  await insert("plan_repositories", planRepositories, () =>
    db.insert(schema.planRepositories).values(
      planRepositories.map((r) => ({
        planId: r.plan_id,
        repoId: r.repo_id,
        position: r.position ?? 0,
      }))
    )
  );

  // Tasks: attached_run_id points at agent_runs (dropped) — null it out.
  const tasks = read(s, "tasks");
  await insert("tasks", tasks, () =>
    db.insert(schema.tasks).values(
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state ?? "todo",
        planId: t.plan_id,
        assignee: t.assignee ?? null,
        body: t.body ?? "",
        estimate: t.estimate ?? null,
        tags: t.tags ?? "[]",
        repoId: t.repo_id ?? null,
        attachedRunId: null,
        createdAt: toDate(t.created_at) ?? undefined,
        updatedAt: toDate(t.updated_at) ?? undefined,
      }))
    )
  );

  const taskDependencies = read(s, "task_dependencies");
  await insert("task_dependencies", taskDependencies, () =>
    db.insert(schema.taskDependencies).values(
      taskDependencies.map((d) => ({ taskId: d.task_id, dependsOnId: d.depends_on_id }))
    )
  );

  const taskNotes = read(s, "task_notes");
  await insert("task_notes", taskNotes, () =>
    db.insert(schema.taskNotes).values(
      taskNotes.map((n) => ({
        id: n.id,
        taskId: n.task_id,
        author: n.author,
        body: n.body,
        createdAt: toDate(n.created_at) ?? undefined,
      }))
    )
  );

  const acceptanceCriteria = read(s, "acceptance_criteria");
  await insert("acceptance_criteria", acceptanceCriteria, () =>
    db.insert(schema.acceptanceCriteria).values(
      acceptanceCriteria.map((c) => ({
        id: c.id,
        taskId: c.task_id,
        text: c.text,
        done: !!c.done,
        position: c.position,
      }))
    )
  );

  const attachments = read(s, "attachments");
  await insert("attachments", attachments, () =>
    db.insert(schema.attachments).values(
      attachments.map((a) => ({
        id: a.id,
        planId: a.plan_id ?? null,
        taskId: a.task_id ?? null,
        filename: a.filename,
        mimeType: a.mime_type,
        kind: a.kind,
        sizeBytes: a.size_bytes,
        content: a.content as Buffer,
        author: a.author,
        createdAt: toDate(a.created_at) ?? undefined,
      }))
    )
  );

  const apiTokens = read(s, "api_tokens");
  await insert("api_tokens", apiTokens, () =>
    db.insert(schema.apiTokens).values(
      apiTokens.map((t) => ({
        id: t.id,
        userId: t.user_id,
        name: t.name,
        tokenHash: t.token_hash,
        prefix: t.prefix,
        createdAt: toDate(t.created_at) ?? undefined,
        lastUsedAt: toDate(t.last_used_at),
        revokedAt: toDate(t.revoked_at),
      }))
    )
  );

  const personaMemories = read(s, "persona_memories");
  await insert("persona_memories", personaMemories, () =>
    db.insert(schema.personaMemories).values(
      personaMemories.map((m) => ({
        id: m.id,
        personaId: m.persona_id,
        scope: m.scope,
        body: m.body ?? "",
        updatedAt: toDate(m.updated_at) ?? undefined,
      }))
    )
  );

  s.close();

  if (!DRY) {
    // Re-sync serial sequences past the migrated max(id) so new inserts don't collide.
    console.log("resyncing serial sequences...");
    for (const table of ["users", "task_notes", "acceptance_criteria", "attachments", "api_tokens", "persona_memories"]) {
      await sql.unsafe(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
      );
    }
  }

  console.log(DRY ? "Dry run complete." : "ETL complete.");
  await sql.end();
}

main().catch((e) => {
  console.error("ETL failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
