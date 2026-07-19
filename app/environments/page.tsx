// The environments view now lives under Settings as a tab. This route is kept
// as a permanent redirect so existing links and bookmarks resolve to the new
// location.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function EnvironmentsPage() {
  redirect("/settings?tab=environments");
}
