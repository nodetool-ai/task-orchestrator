import { db } from "../../db";
import { sql } from "drizzle-orm";
import type { CodeActExecutionReceipt, CodeActReceiptStore, CodeActSubcallReceipt } from "./bridge";

/** Postgres-backed receipt store. Each subcall is inserted before dispatch and
 * updated independently, so a crash leaves an explicit unknown/running record
 * to reconcile instead of replaying the guest script. */
export class PostgresCodeActReceiptStore implements CodeActReceiptStore {
  constructor(private readonly runId: number) {}

  async begin(receipt: CodeActExecutionReceipt): Promise<void> {
    await db.execute(sql`INSERT INTO codeact_executions (execution_id, run_id, source_sha256, status, receipt)
      VALUES (${receipt.executionId}::uuid, ${this.runId}, ${receipt.sourceSha256}, ${receipt.status}, ${JSON.stringify(receipt)}::jsonb)
      ON CONFLICT (execution_id) DO NOTHING`);
  }

  async subcall(receipt: CodeActSubcallReceipt): Promise<void> {
    await db.execute(sql`INSERT INTO codeact_subcalls (subcall_id, execution_id, operation, input, status, result, error)
      VALUES (${receipt.subcallId}::uuid, ${receipt.executionId}::uuid, ${receipt.operation}, ${JSON.stringify(receipt.input)}::jsonb, ${receipt.status}, ${receipt.result === undefined ? null : JSON.stringify(receipt.result)}::jsonb, ${receipt.error ?? null})
      ON CONFLICT (subcall_id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, error = EXCLUDED.error, completed_at = CASE WHEN EXCLUDED.status <> 'running' THEN now() ELSE codeact_subcalls.completed_at END`);
  }

  async finish(executionId: string, patch: Partial<CodeActExecutionReceipt>): Promise<void> {
    await db.execute(sql`UPDATE codeact_executions SET status = ${patch.status ?? "unknown"}, receipt = ${JSON.stringify(patch)}::jsonb, completed_at = now() WHERE execution_id = ${executionId}::uuid`);
  }
}
