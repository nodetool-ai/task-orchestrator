import { ApiTokensManager } from "@/components/api-tokens-manager";
import { CodeBlock } from "@/components/ui/code-block";

export const dynamic = "force-dynamic";

export default function TokensPage() {
  return (
    <main style={{ padding: "20px 20px 80px", maxWidth: 1480, margin: "0 auto" }} className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">API tokens</h1>
        <p className="text-sm text-muted-foreground">
          Tokens authenticate the MCP server at <code>POST /api/mcp</code>. Pass{" "}
          <code>Authorization: Bearer tot_…</code>. Each token inherits its owner&apos;s
          permissions; revoke any time.
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs space-y-1.5">
            <div className="font-medium">Claude Code (CLI):</div>
            <CodeBlock tone="muted" className="border-0 bg-transparent p-0">{`claude mcp add --transport http \\
  task-orchestrator \\
  https://tasks.nodetool.ai/api/mcp \\
  --header "Authorization: Bearer tot_…"`}</CodeBlock>
          </div>

          <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs space-y-1.5">
            <div className="font-medium">Claude Desktop:</div>
            <CodeBlock tone="muted" className="border-0 bg-transparent p-0">{`{
  "mcpServers": {
    "task-orchestrator": {
      "type": "http",
      "url": "https://tasks.nodetool.ai/api/mcp",
      "headers": { "Authorization": "Bearer tot_…" }
    }
  }
}`}</CodeBlock>
          </div>

          <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs space-y-1.5">
            <div className="font-medium">Cursor (~/.cursor/mcp.json):</div>
            <CodeBlock tone="muted" className="border-0 bg-transparent p-0">{`{
  "mcpServers": {
    "task-orchestrator": {
      "url": "https://tasks.nodetool.ai/api/mcp",
      "headers": { "Authorization": "Bearer tot_…" }
    }
  }
}`}</CodeBlock>
          </div>
        </div>
      </header>
      <ApiTokensManager />
    </main>
  );
}
