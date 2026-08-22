// The needs-you list. The server denormalises persona and PR onto each row
// (T-tui-04), so this is a shape conversion plus the ordering guarantee.

import type { GlobalInboxRow } from "../api/types.js";

export interface InboxItem {
  id: string;
  runId: number;
  persona: string;
  kind: "question" | "review" | "stuck" | "budget";
  text: string;
  at: number;
  prUrl: string | null;
}

export function toInboxItems(rows: GlobalInboxRow[]): InboxItem[] {
  return rows
    .map((r) => ({
      id: r.id,
      runId: r.runId,
      persona: r.personaName ?? r.personaId ?? "agent",
      kind: r.kind,
      text: r.text.replace(/\s+/g, " ").trim(),
      at: epoch(r.createdAt),
      prUrl: r.prUrl,
    }))
    // Newest first. The server already sorts, but the list is also assembled
    // from more than one poll, so re-establish the invariant here.
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
