// /sessions/[id] has been folded into /runs/[id] (the agent_runs id is
// stable, so the path translation is a simple swap). One-release shim;
// delete with the rest of the legacy routes.
import { redirect } from "next/navigation";

export default async function SessionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/runs/${id}`);
}
