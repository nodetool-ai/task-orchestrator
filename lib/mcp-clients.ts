// Connection recipes for the hosted MCP server (POST /api/mcp).
//
// One place decides what a working client config looks like, so the
// settings UI, the `.mcp.json` download, and docs/mcp-server.md can never
// drift apart. Everything here is pure — no DB, no window — so it renders
// on the server and is unit-testable.

export const MCP_ENDPOINT_PATH = "/api/mcp";

/** Default server name clients register us under. */
export const MCP_SERVER_NAME = "task-orchestrator";

/**
 * Stand-in shown before a token exists. Snippets stay copy-pasteable
 * shapes; the user swaps this for the secret shown once at creation.
 */
export const MCP_TOKEN_PLACEHOLDER = "tot_YOUR_TOKEN";

export interface McpConnection {
  /** Public origin of the deployment, e.g. https://tasks.nodetool.ai */
  origin: string;
  /** Plaintext token, or MCP_TOKEN_PLACEHOLDER when none is in hand. */
  token: string;
  /** Name the client registers the server under. */
  serverName?: string;
}

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_ENDPOINT_PATH}`;
}

function name(conn: McpConnection): string {
  return conn.serverName ?? MCP_SERVER_NAME;
}

/**
 * The standard MCP server entry — the object every JSON-config client nests
 * under its own `mcpServers` key.
 */
export function mcpServerEntry(conn: McpConnection): Record<string, unknown> {
  return {
    type: "http",
    url: mcpEndpoint(conn.origin),
    headers: { Authorization: `Bearer ${conn.token}` },
  };
}

/** Contents of a project-scoped `.mcp.json`. */
export function mcpJsonFile(conn: McpConnection): string {
  return (
    JSON.stringify(
      { mcpServers: { [name(conn)]: mcpServerEntry(conn) } },
      null,
      2
    ) + "\n"
  );
}

export interface McpClientRecipe {
  id: string;
  label: string;
  /** Where the snippet goes, in one line. */
  hint: string;
  /** "shell" renders as a command, "json" as a config file body. */
  format: "shell" | "json";
  snippet(conn: McpConnection): string;
  /** One-click install URL, for clients that register a handler. */
  deepLink?(conn: McpConnection): string;
}

function base64(value: string): string {
  // Works in both runtimes: Buffer on Node, btoa in the browser.
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(value)));
}

export const MCP_CLIENTS: McpClientRecipe[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run once; stored in ~/.claude.json for the current scope.",
    format: "shell",
    snippet: (conn) =>
      `claude mcp add --transport http \\
  ${name(conn)} \\
  ${mcpEndpoint(conn.origin)} \\
  --header "Authorization: Bearer ${conn.token}"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint: "Settings → Developer → Edit Config (claude_desktop_config.json).",
    format: "json",
    snippet: (conn) => mcpJsonFile(conn).trimEnd(),
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "~/.cursor/mcp.json (global) or .cursor/mcp.json (per project).",
    format: "json",
    snippet: (conn) => mcpJsonFile(conn).trimEnd(),
    deepLink: (conn) =>
      `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(
        name(conn)
      )}&config=${encodeURIComponent(base64(JSON.stringify(mcpServerEntry(conn))))}`,
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: ".vscode/mcp.json in the workspace, under a `servers` key.",
    format: "json",
    snippet: (conn) =>
      JSON.stringify({ servers: { [name(conn)]: mcpServerEntry(conn) } }, null, 2),
    deepLink: (conn) =>
      `vscode:mcp/install?${encodeURIComponent(
        JSON.stringify({ name: name(conn), ...mcpServerEntry(conn) })
      )}`,
  },
  {
    id: "mcp-json",
    label: ".mcp.json",
    hint: "Commit-free project file read by Claude Code and other MCP clients.",
    format: "json",
    snippet: (conn) => mcpJsonFile(conn).trimEnd(),
  },
  {
    id: "curl",
    label: "curl",
    hint: "Smoke-test the endpoint from anywhere with the token.",
    format: "shell",
    snippet: (conn) =>
      `curl -sS ${mcpEndpoint(conn.origin)} \\
  -H "Authorization: Bearer ${conn.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
];

export function findMcpClient(id: string): McpClientRecipe | undefined {
  return MCP_CLIENTS.find((c) => c.id === id);
}
