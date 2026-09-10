// `/` is the concierge: a conversation, not a dashboard. The operator view
// that used to live here still exists in full at /overview.
import { ConciergeHome } from "@/components/concierge/concierge-home";
import { getDefaultModel } from "@/lib/chat";
import { conversationPulse, selectConversations } from "@/lib/concierge-home";
import * as repo from "@/lib/repo";
import { getRunOverview } from "@/lib/run-overview";
import type { RunIndexRow } from "@/lib/run-index";

export const dynamic = "force-dynamic";

export default async function ConciergeHomePage() {
  // A first-boot or degraded database must still render the front door — the
  // composer is the point, and the conversation list is decoration around it.
  let rows: RunIndexRow[] = [];
  let repositories: Array<{ id: string; name: string }> = [];
  try {
    const [loadedRows, repoRows] = await Promise.all([
      getRunOverview(),
      repo.listRepositories(),
    ]);
    rows = loadedRows;
    repositories = repoRows.map((r) => ({ id: r.id, name: r.name }));
  } catch {
    // Fall through to the calm start state.
  }

  return (
    <ConciergeHome
      defaultModel={getDefaultModel()}
      repositories={repositories}
      conversations={selectConversations(rows)}
      pulse={conversationPulse(rows)}
    />
  );
}
