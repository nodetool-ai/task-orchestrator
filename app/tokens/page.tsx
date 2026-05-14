import { ApiTokensManager } from "@/components/api-tokens-manager";

export const dynamic = "force-dynamic";

export default function TokensPage() {
  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">API tokens</h1>
        <p className="text-sm text-muted-foreground">
          Tokens authenticate the MCP server at <code>POST /api/mcp</code>. Pass{" "}
          <code>Authorization: Bearer tot_…</code>. Each token inherits its owner&apos;s
          permissions; revoke any time.
        </p>
        <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs space-y-1.5">
          <div className="font-medium">Connect from Claude Desktop / Code:</div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">{`{
  "mcpServers": {
    "task-orchestrator": {
      "type": "http",
      "url": "https://tasks.nodetool.ai/api/mcp",
      "headers": { "Authorization": "Bearer tot_…" }
    }
  }
}`}</pre>
        </div>
      </header>
      <ApiTokensManager />
    </main>
  );
}
