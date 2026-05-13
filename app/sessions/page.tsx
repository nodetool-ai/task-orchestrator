// /sessions has been folded into /runs. This redirect lives for one
// release so external links and bookmarks keep working; it can be deleted
// in the follow-up that removes the legacy routes.
import { redirect } from "next/navigation";

export default function SessionsRedirect() {
  redirect("/runs");
}
