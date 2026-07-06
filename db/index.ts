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

// A single lazily-CREATED and lazily-connecting postgres.js client, reused
// across HMR / module reloads via globals. Creation is deferred to first use
// (behind the proxies below) so that a process which never touches the DB —
// an HTTP-mode worker speaking the /api/worker protocol — can run WITHOUT
// DATABASE_URL. Any accidental direct DB access in such a worker then fails
// loudly at the exact call site with an actionable message instead of at
// import time. Migrations + seeding run out-of-band via initDb() (boot / test
// setup), not at import time.
function createClient(): Client {
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
  return postgres(dbUrl, {
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
}

function ensureClient(): Client {
  if (!globalThis.__tasksPg) {
    if (!process.env.DATABASE_URL && process.env.TASK_ORCH_WORKER_API_URL) {
      // The one misconfiguration this proxy exists to catch: an HTTP-mode
      // worker (no DATABASE_URL) reached a code path that still talks to
      // Postgres directly. Name the situation instead of "DATABASE_URL is
      // not set".
      throw new Error(
        "Direct database access attempted in an HTTP-mode worker (DATABASE_URL " +
          "is unset; TASK_ORCH_WORKER_API_URL is set). This code path has not " +
          "been routed through the worker transport (lib/worker) yet — see " +
          "docs/worker-http-api.md."
      );
    }
    globalThis.__tasksPg = createClient();
  }
  return globalThis.__tasksPg;
}

function ensureDb(): DB {
  if (!globalThis.__tasksDb) {
    globalThis.__tasksDb = drizzle(ensureClient(), { schema });
  }
  return globalThis.__tasksDb;
}

// The public `db` / `sql` exports keep their historical shapes (a drizzle
// instance and a callable postgres.js client) but defer construction to first
// use via proxies. postgres.js clients are callable tagged-template functions
// with methods (listen/unsafe/end), so the sql proxy needs both traps.
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = ensureDb();
    const v = (real as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
  has(_t, prop) {
    return prop in (ensureDb() as object);
  },
});

/** Raw postgres.js client — for LISTEN/NOTIFY and the migrator. */
export const sql: Client = new Proxy(function () {} as unknown as Client, {
  get(_t, prop) {
    const real = ensureClient();
    const v = (real as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
  apply(_t, _this, args) {
    const real = ensureClient();
    return (real as unknown as (...a: unknown[]) => unknown)(...args);
  },
  has(_t, prop) {
    return prop in (ensureClient() as object);
  },
});
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
        await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`);
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
