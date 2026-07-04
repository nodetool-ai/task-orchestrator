// /chat has been folded into /runs: chats and runs now share one unified
// index (a chat is a run with goal '<chat>'), with the new-chat composer at
// the top of /runs. This redirect lives for one release so links and
// bookmarks keep working; /chat/[id] keeps its own legacy-id shim.
import { redirect } from "next/navigation";

export default function ChatRedirect() {
  redirect("/runs");
}
