import { PlansIndex } from "@/components/pi/plans-index";
import { loadPlansIndexData } from "@/lib/pi-floor-data";

export const dynamic = "force-dynamic";

export default async function PlansIndexPage() {
  const plans = loadPlansIndexData();
  return <PlansIndex plans={plans} />;
}
