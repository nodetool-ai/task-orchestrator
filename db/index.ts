import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and, or, isNull, ne } from "drizzle-orm";
import * as schema from "./schema";
import { PERSONAS } from "@/lib/personas";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In the bundled Next server (or a container), db/index.ts's __dirname resolves
// into .next/server rather than the source db/ dir, so the migration .sql files
// aren't beside it. TASK_ORCH_MIGRATIONS_DIR lets the runtime point at the
// copied-in migrations folder; dev/tests (tsx, unbundled) use the default.
const MIGRATIONS_DIR = process.env.TASK_ORCH_MIGRATIONS_DIR || join(__dirname, "migrations");

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at Postgres, e.g. " +
        "postgres://user:pass@host:5432/task_orchestrator"
    );
  }
  return url;
}

type DB = PostgresJsDatabase<typeof schema>;
type Client = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __tasksDb: DB | undefined;
  // eslint-disable-next-line no-var
  var __tasksPg: Client | undefined;
}

// Optional per-connection schema. Tests set TASK_ORCH_PG_SCHEMA to a unique name
// per worker process so parallel test files get fully isolated tables (the
// Postgres analog of the old file-per-process SQLite setup). Unset in prod →
// the default `public` schema.
const PG_SCHEMA = process.env.TASK_ORCH_PG_SCHEMA;

// A single lazily-connecting postgres.js client, reused across HMR / module
// reloads via globals. Unlike better-sqlite3, the connection is async and opens
// on first query — so the drizzle instance is still created synchronously here,
// keeping the `db` export shape stable. Migrations + seeding run out-of-band via
// initDb() (boot / test setup), not at import time.
const dbUrl = databaseUrl();
// Supabase (and any explicit sslmode=require URL) requires TLS; a local dev/CI
// Postgres does not. Auto-enable so the same code works against both without a
// separate flag. `ssl: "require"` does TLS without CA verification, which the
// Supabase poolers accept.
const needsSsl = /supabase\.(co|com)/i.test(dbUrl) || /[?&]sslmode=require/i.test(dbUrl);
// Supavisor TRANSACTION mode (port 6543) supports neither prepared statements
// nor LISTEN/NOTIFY. This app depends on LISTEN/NOTIFY (run_stream + run_input),
// so the SESSION-mode pooler (port 5432) is required. Guard loudly if a 6543 URL
// slips in, and at least turn off prepared statements so plain queries survive.
const isTxnPooler = /pooler\.supabase\.com:6543/i.test(dbUrl);
if (isTxnPooler) {
  console.warn(
    "[db] DATABASE_URL points at the Supabase TRANSACTION pooler (:6543), which " +
      "does not support LISTEN/NOTIFY — run streaming and worker messaging will " +
      "silently stop working. Switch to the SESSION pooler (:5432)."
  );
}

const client: Client =
  globalThis.__tasksPg ??
  postgres(dbUrl, {
    max: 10,
    // Recycle connections proactively to reduce stale-socket resets — an idle
    // connection dropped by flycast/the DB surfaces as an ECONNRESET on next use
    // (which can crash detached workers). Closing idle connections after 30s and
    // capping lifetime at 30min makes that far less likely; postgres.js
    // reconnects transparently. The worker's process safety net still backstops
    // any reset that slips through.
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 30,
    onnotice: () => {},
    ...(needsSsl ? { ssl: "require" as const } : {}),
    ...(isTxnPooler ? { prepare: false } : {}),
    ...(PG_SCHEMA ? { connection: { search_path: PG_SCHEMA } } : {}),
  });
if (!globalThis.__tasksPg) globalThis.__tasksPg = client;

export const db: DB = globalThis.__tasksDb ?? drizzle(client, { schema });
if (!globalThis.__tasksDb) globalThis.__tasksDb = db;

/** Raw postgres.js client — for LISTEN/NOTIFY and the migrator. */
export const sql = client;
export { schema };

let initPromise: Promise<void> | null = null;

/**
 * Apply pending migrations and seed required rows. Idempotent and safe to call
 * on every boot (instrumentation.ts) and from test setup. Memoized so concurrent
 * callers share one run.
 */
export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      if (PG_SCHEMA) {
        // Test isolation: create the per-worker schema and keep its migration
        // journal inside it, so parallel workers never share migration state.
        await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`);
      }
      await migrate(db, {
        migrationsFolder: MIGRATIONS_DIR,
        ...(PG_SCHEMA ? { migrationsSchema: PG_SCHEMA } : {}),
      });
      await seedDefaultRepo();
      await seedRequiredPersonas();
      await syncDefaultRepoFromEnv();
    })();
  }
  return initPromise;
}

// The R-default repository row (name/branch that agent_runs.repo_id, plans, and
// tasks default to). The legacy SQLite migration 0006 seeded it inline; the
// regenerated Postgres migration carries schema only, so seed it here on every
// cold start. onConflictDoNothing preserves any UI/env edits to the row.
async function seedDefaultRepo(): Promise<void> {
  try {
    await db
      .insert(schema.repositories)
      .values({
        id: "R-default",
        name: "default",
        defaultBranch: "main",
        description: "Auto-seeded default repository.",
      })
      .onConflictDoNothing();
  } catch (err) {
    console.warn("db: failed to seed R-default repository:", err);
  }
}

// Personas are code-defined (lib/personas/*.ts) but agent_runs.persona_id carries
// a foreign key into the personas table, so a migrated-but-unseeded DB makes every
// run-create fail with a FK violation. `npm run db:seed` is the manual path; this
// guarantees the FK targets exist on every cold start too. onConflictDoNothing is
// insert-if-missing: persona rows edited through the UI are left untouched.
export async function seedRequiredPersonas(): Promise<void> {
  try {
    const rows = PERSONAS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      systemPrompt: p.systemPrompt,
      thinkingLevel: p.thinkingLevel ?? null,
      toolsProfile: p.toolsProfile,
      budgetMaxTurns: p.budget?.maxTurns ?? null,
      budgetMaxSeconds: p.budget?.maxSeconds ?? null,
    }));
    if (rows.length) {
      await db.insert(schema.personas).values(rows).onConflictDoNothing();
    }
  } catch (err) {
    console.warn("db: failed to seed required personas:", err);
  }
}

// One-shot bridge: if TASK_ORCH_TARGET_REPO is set, ensure R-default's local_path
// reflects it. Lets users run the "one repo per deployment" setup purely via env.
async function syncDefaultRepoFromEnv(): Promise<void> {
  const target = process.env.TASK_ORCH_TARGET_REPO;
  if (!target) return;
  try {
    await db
      .update(schema.repositories)
      .set({ localPath: target, updatedAt: new Date() })
      .where(
        and(
          eq(schema.repositories.id, "R-default"),
          or(isNull(schema.repositories.localPath), ne(schema.repositories.localPath, target))
        )
      );
  } catch (err) {
    console.warn("db: failed to sync R-default.local_path from env:", err);
  }
}
