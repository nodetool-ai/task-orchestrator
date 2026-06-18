import { PlansIndex } from "@/components/pi/plans-index";
import { loadPlansIndexData } from "@/lib/pi-floor-data";
import { listRepositories } from "@/lib/repo";

export const dynamic = "force-dynamic";

export default async function PlansIndexPage() {
  const plans = loadPlansIndexData();
  const repos = listRepositories().map((r) => ({ id: r.id, name: r.name }));
  return <PlansIndex plans={plans} repos={repos} />;
}
