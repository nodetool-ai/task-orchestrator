import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages } from "@/db/schema";

const ACTIVITY_WINDOW = 200;
const RECENT_ACTIVITY_LIMIT = 12;

type ActivityRow = {
  id: number;
  role: string;
  content: string;
  createdAt: Date;
};

type ParsedBlock = Record<string, unknown>;

function blocksOf(content: string): ParsedBlock[] {
  try {
    const parsed: unknown = JSON.parse(content);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    return blocks.filter(
      (block): block is ParsedBlock => block !== null && typeof block === "object"
    );
  } catch {
    return [];
  }
}

function stringField(block: ParsedBlock, key: string): string | null {
  const value = block[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A content-free supervision projection of persisted worker activity.
 *
 * Parent agents need timestamps and open-tool identity to distinguish a quiet
 * model from one that is actively editing or blocked in a long command. Never
 * return tool inputs/results here: those can contain source, credentials, or a
 * very large build log and are not needed for liveness classification.
 */
export function summarizeRunActivity(
  rowsDescending: readonly ActivityRow[],
  now = new Date()
) {
  const rows = [...rowsDescending].reverse();
  const openTools = new Map<
    string,
    { tool_use_id: string; tool_name: string; started_at: string; message_id: number }
  >();
  const lastAgentAt = rowsDescending.find((row) => row.role === "agent")?.createdAt ?? null;
  const lastToolResultAt =
    rowsDescending.find((row) => row.role === "tool")?.createdAt ?? null;

  const projected = rows.map((row) => {
    const blocks = blocksOf(row.content);
    const kinds = new Set<string>();
    const toolNames = new Set<string>();

    for (const block of blocks) {
      const type = stringField(block, "type") ?? "unknown";
      kinds.add(type);
      if (type === "tool_use") {
        const id = stringField(block, "id");
        const name = stringField(block, "name") ?? "unknown";
        toolNames.add(name);
        if (id) {
          openTools.set(id, {
            tool_use_id: id,
            tool_name: name,
            started_at: row.createdAt.toISOString(),
            message_id: row.id,
          });
        }
      } else if (type === "tool_result") {
        const id = stringField(block, "tool_use_id");
        if (id) openTools.delete(id);
      }
    }

    return {
      message_id: row.id,
      role: row.role,
      created_at: row.createdAt.toISOString(),
      block_types: [...kinds],
      tool_names: [...toolNames],
    };
  });

  const lastWorkerAt = [lastAgentAt, lastToolResultAt]
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const inFlightTools = [...openTools.values()]
    .sort((a, b) => a.message_id - b.message_id)
    .map((tool) => ({
      ...tool,
      age_ms: Math.max(0, now.getTime() - new Date(tool.started_at).getTime()),
    }));

  return {
    last_worker_activity_at: lastWorkerAt?.toISOString() ?? null,
    last_agent_activity_at: lastAgentAt?.toISOString() ?? null,
    last_tool_result_at: lastToolResultAt?.toISOString() ?? null,
    in_flight_tools: inFlightTools,
    activity_window_truncated: rowsDescending.length === ACTIVITY_WINDOW,
    recent_activity: projected.slice(-RECENT_ACTIVITY_LIMIT),
  };
}

export async function getRunActivitySnapshot(runId: number) {
  const rows = await db
    .select({
      id: agentMessages.id,
      role: agentMessages.role,
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
    })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.runId, runId),
        inArray(agentMessages.role, ["agent", "tool"])
      )
    )
    .orderBy(desc(agentMessages.id))
    .limit(ACTIVITY_WINDOW);
  return summarizeRunActivity(rows);
}
