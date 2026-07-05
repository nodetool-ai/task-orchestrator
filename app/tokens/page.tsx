import { redirect } from "next/navigation";

export default function TokensRedirect() {
  redirect("/settings?tab=tokens");
}
