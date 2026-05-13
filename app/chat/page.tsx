// /chat has been folded into /runs. One-release shim; delete with the
// rest of the legacy routes.
import { redirect } from "next/navigation";

export default function ChatRedirect() {
  redirect("/runs");
}
