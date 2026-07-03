import { renderMarkdown } from "@/lib/markdown";
import { EmptyState } from "@/components/ui/empty-state";

export function MarkdownBody({ source }: { source: string }) {
  const html = renderMarkdown(source);
  if (!html.trim()) {
    return <EmptyState className="text-sm italic">No description yet.</EmptyState>;
  }
  return <div className="prose-tasks" dangerouslySetInnerHTML={{ __html: html }} />;
}
