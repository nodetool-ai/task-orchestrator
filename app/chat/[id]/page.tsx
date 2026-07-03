// /chat/[id] → /runs/[id]. For chats that existed before migration 0009
// the URL still uses the old chats.id; we look that up in
// agent_runs.legacy_chat_id to find the new run id. For chats created
// after the migration the id is already an agent_runs.id and the lookup
// just falls through. One-release shim.
import { notFound, redirect } from "next/navigation";
import { getRun, resolveLegacyChatId } from "@/lib/runs";

export default async function ChatDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) notFound();

  const fromLegacy = await resolveLegacyChatId(numeric);
  if (fromLegacy !== null) {
    redirect(`/runs/${fromLegacy}`);
  }
  // No legacy mapping: assume the URL already carries the new run id.
  // (Chats created after 0009 work this way.) 404 if there's no such run
  // rather than silently sending the user to a missing /runs/<id>.
  const run = await getRun(numeric);
  if (!run) notFound();
  redirect(`/runs/${numeric}`);
}
