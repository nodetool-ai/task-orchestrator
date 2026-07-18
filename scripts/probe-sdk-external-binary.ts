// Can the Claude Agent SDK drive an EXTERNAL claude binary (pathToClaudeCodeExecutable)
// instead of its bundled 216MB platform package? Proves the box can reuse its
// preinstalled /usr/local/bin/claude and skip the optional binary dep entirely.
const bin = process.argv[2] ?? "/usr/local/bin/claude";
const { query } = await import("@anthropic-ai/claude-agent-sdk");
console.log(`[probe] driving SDK against ${bin}`);
const stream = query({
  prompt: "Reply with exactly: EXTERNAL_BINARY_OK",
  options: {
    pathToClaudeCodeExecutable: bin,
    permissionMode: "bypassPermissions",
    // Keep it hermetic: no MCP, no ambient project config.
    strictMcpConfig: true,
    mcpServers: {},
  } as any,
});
for await (const msg of stream) {
  if (msg.type === "system" && (msg as any).subtype === "init") {
    console.log("[probe] init ok, session:", (msg as any).session_id);
  }
  if (msg.type === "result") {
    console.log("[probe] result:", JSON.stringify((msg as any).result ?? "").slice(0, 120));
    console.log("[probe] is_error:", (msg as any).is_error);
  }
}
console.log("[probe] stream completed cleanly");
