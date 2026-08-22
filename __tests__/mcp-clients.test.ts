import { describe, expect, it } from "vitest";
import {
  MCP_CLIENTS,
  MCP_TOKEN_PLACEHOLDER,
  findMcpClient,
  mcpEndpoint,
  mcpJsonFile,
  mcpServerEntry,
} from "../lib/mcp-clients";

const conn = { origin: "https://tasks.example.com", token: "tot_abc123" };

describe("mcp client recipes", () => {
  it("builds the endpoint from the origin, tolerating a trailing slash", () => {
    expect(mcpEndpoint("https://tasks.example.com")).toBe(
      "https://tasks.example.com/api/mcp"
    );
    expect(mcpEndpoint("https://tasks.example.com/")).toBe(
      "https://tasks.example.com/api/mcp"
    );
  });

  it("emits an http server entry carrying the bearer header", () => {
    expect(mcpServerEntry(conn)).toEqual({
      type: "http",
      url: "https://tasks.example.com/api/mcp",
      headers: { Authorization: "Bearer tot_abc123" },
    });
  });

  it("writes a .mcp.json that parses back to the same entry", () => {
    const parsed = JSON.parse(mcpJsonFile(conn));
    expect(parsed.mcpServers["task-orchestrator"]).toEqual(mcpServerEntry(conn));
  });

  it("puts endpoint and token into every client snippet", () => {
    for (const client of MCP_CLIENTS) {
      const snippet = client.snippet(conn);
      expect(snippet, client.id).toContain("https://tasks.example.com/api/mcp");
      expect(snippet, client.id).toContain("tot_abc123");
    }
  });

  it("keeps JSON snippets parseable", () => {
    for (const client of MCP_CLIENTS.filter((c) => c.format === "json")) {
      expect(() => JSON.parse(client.snippet(conn)), client.id).not.toThrow();
    }
  });

  it("uses `servers` for VS Code and `mcpServers` elsewhere", () => {
    const vscode = JSON.parse(findMcpClient("vscode")!.snippet(conn));
    expect(vscode.servers["task-orchestrator"]).toEqual(mcpServerEntry(conn));
    const cursor = JSON.parse(findMcpClient("cursor")!.snippet(conn));
    expect(cursor.mcpServers).toBeDefined();
  });

  it("encodes a Cursor deep link whose config round-trips", () => {
    const link = findMcpClient("cursor")!.deepLink!(conn);
    const config = new URL(link).searchParams.get("config")!;
    expect(JSON.parse(Buffer.from(config, "base64").toString("utf8"))).toEqual(
      mcpServerEntry(conn)
    );
  });

  it("encodes a VS Code deep link carrying the server name", () => {
    const link = findMcpClient("vscode")!.deepLink!(conn);
    const payload = JSON.parse(
      decodeURIComponent(link.slice(link.indexOf("?") + 1))
    );
    expect(payload.name).toBe("task-orchestrator");
    expect(payload.url).toBe("https://tasks.example.com/api/mcp");
  });

  it("carries a visible placeholder when no token is in hand", () => {
    const snippet = findMcpClient("claude-code")!.snippet({
      origin: conn.origin,
      token: MCP_TOKEN_PLACEHOLDER,
    });
    expect(snippet).toContain(MCP_TOKEN_PLACEHOLDER);
    expect(MCP_TOKEN_PLACEHOLDER.startsWith("tot_")).toBe(true);
  });
});
