import { FactoryFloor } from "@/components/pi/factory-floor";
import { loadFloorData } from "@/lib/pi-floor-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = loadFloorData();
  return <FactoryFloor {...data} />;
}
