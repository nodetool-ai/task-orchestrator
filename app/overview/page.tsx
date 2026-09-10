// The operator dashboard — every run, queue, cost and criterion on one floor.
// It moved off `/` when the concierge conversation became the front door
// (docs/superpowers/specs/2026-09-07-concierge-first-homepage-prd.md §13); it
// is unchanged, and stays directly linked from the primary navigation for the
// times someone wants the machinery rather than the conversation.
import { FactoryFloor } from "@/components/pi/factory-floor";
import { loadFloorData } from "@/lib/pi-floor-data";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const data = await loadFloorData();
  return <FactoryFloor {...data} />;
}
