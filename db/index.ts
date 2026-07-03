import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and, or, isNull, ne } from "drizzle-orm";
import * as schema from "./schema";
import { PERSONAS } from "@/lib/personas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

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

// A single lazily-connecting postgres.js client, reused across HMR / module
// reloads via globals. Unlike better-sqlite3, the connection is async and opens
// on first query — so the drizzle instance is still created synchronously here,
// keeping the `db` export shape stable. Migrations + seeding run out-of-band via
// initDb() (boot / test setup), not at import time.
const client: Client =
  globalThis.__tasksPg ?? postgres(databaseUrl(), { max: 10, onnotice: () => {} });
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
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      await seedRequiredPersonas();
      await syncDefaultRepoFromEnv();
    })();
  }
  return initPromise;
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
