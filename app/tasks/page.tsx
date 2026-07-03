import { TasksIndex } from "@/components/pi/tasks-index";
import { loadTasksIndexData } from "@/lib/pi-floor-data";

export const dynamic = "force-dynamic";

export default async function TasksIndexPage() {
  const { rows, plans } = await loadTasksIndexData();
  return <TasksIndex rows={rows} plans={plans} />;
}
