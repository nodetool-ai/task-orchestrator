import { db, codeActOwnershipDb } from "../../db";
import { sql } from "drizzle-orm";
import { recoverCodeActExecution, extractCodeActLinks, type CodeActExecutionReceipt, type CodeActReceiptStore, type CodeActSubcallReceipt } from "./bridge";

/** Postgres-backed receipt store. Each subcall is inserted before dispatch and
 * updated independently, so a crash leaves an explicit unknown/running record
 * to reconcile instead of replaying the guest script. */
export class PostgresCodeActReceiptStore implements CodeActReceiptStore {
  constructor(private readonly runId: number, private readonly database: Pick<typeof db, "execute"> = db) {}

  async withOwnership<T>(executionId: string, execute: () => Promise<T>): Promise<T> {
    return codeActOwnershipDb().transaction(async (tx) => {
      // The lock is acquired BEFORE begin() publishes the receipt. A crash
      // releases it automatically; another process can never recover live work.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':codeact:' || ${executionId}, 0))`);
      return execute();
    });
  }

  async begin(receipt: CodeActExecutionReceipt): Promise<void> {
    await this.database.execute(sql`INSERT INTO codeact_executions (execution_id, run_id, source_sha256, status, receipt)
      VALUES (${receipt.executionId}::uuid, ${this.runId}, ${receipt.sourceSha256}, ${receipt.status}, ${JSON.stringify(receipt)}::jsonb)
      ON CONFLICT (execution_id) DO NOTHING`);
  }

  async subcall(receipt: CodeActSubcallReceipt): Promise<void> {
    await this.database.execute(sql`INSERT INTO codeact_subcalls (subcall_id, execution_id, operation, input, status, result, error)
      VALUES (${receipt.subcallId}::uuid, ${receipt.executionId}::uuid, ${receipt.operation}, ${JSON.stringify(receipt.input)}::jsonb, ${receipt.status}, ${receipt.result === undefined ? null : JSON.stringify(receipt.result)}::jsonb, ${receipt.error ?? null})
      ON CONFLICT (subcall_id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, error = EXCLUDED.error, completed_at = CASE WHEN EXCLUDED.status <> 'running' THEN now() ELSE codeact_subcalls.completed_at END`);
  }

  async finish(executionId: string, patch: Partial<CodeActExecutionReceipt>): Promise<void> {
    await this.database.execute(sql`UPDATE codeact_executions SET status = ${patch.status ?? "unknown"}, receipt = ${JSON.stringify(patch)}::jsonb, completed_at = now() WHERE execution_id = ${executionId}::uuid`);
  }
}

/** Reconcile durable facts only. Never execute or replay the guest source.
 * Try-locking skips active executions, including ones owned by another process.
 * The receipt row is rechecked under lock to fence concurrent finish/recovery. */
export async function recoverOrphanedCodeActExecutions(): Promise<number> {
  const candidates = await db.execute<{ execution_id: string }>(sql`
    SELECT execution_id FROM codeact_executions WHERE status = 'running'`);
  let recovered = 0;
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ acquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':codeact:' || ${candidate.execution_id}, 0)) AS acquired`);
      if (!lock.acquired) return;
      const [execution] = await tx.execute<{ run_id: number; receipt: CodeActExecutionReceipt }>(sql`
        SELECT run_id, receipt FROM codeact_executions
        WHERE execution_id = ${candidate.execution_id}::uuid AND status = 'running' FOR UPDATE`);
      if (!execution) return;
      const subcalls = await tx.execute<{
        subcall_id: string; operation: string; input: unknown;
        status: CodeActSubcallReceipt["status"]; result: unknown; error: string | null;
        started_at: Date; completed_at: Date | null;
      }>(sql`SELECT * FROM codeact_subcalls WHERE execution_id = ${candidate.execution_id}::uuid ORDER BY started_at, subcall_id`);
      const receipt = execution.receipt;
      receipt.subcalls = subcalls.map((row) => ({
        executionId: candidate.execution_id,
        subcallId: row.subcall_id,
        operation: row.operation,
        input: row.input,
        status: row.status,
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.error === null ? {} : { error: row.error }),
        startedAt: new Date(row.started_at).toISOString(),
        ...(row.completed_at ? {
          completedAt: new Date(row.completed_at).toISOString(),
          durationMs: Math.max(0, +new Date(row.completed_at) - +new Date(row.started_at)),
        } : {}),
        links: extractCodeActLinks(row.result),
      }));
      receipt.links = extractCodeActLinks(receipt.subcalls.map((subcall) => subcall.result));
      await recoverCodeActExecution(receipt, new PostgresCodeActReceiptStore(execution.run_id, tx));
      recovered += 1;
    });
  }
  return recovered;
}
