// All /chat routes now redirect to /runs; the layout is a passthrough
// while the legacy paths are still around. Deletes with the rest.
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
