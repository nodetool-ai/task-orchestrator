import { redirect } from "next/navigation";

export default function PersonasRedirect() {
  redirect("/settings?tab=personas");
}
