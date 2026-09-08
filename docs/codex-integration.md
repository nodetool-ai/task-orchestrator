# Codex integration decisions and verification

Reviewed against official documentation on 2026-09-08.

## Runtime choice

Keep `@openai/codex-sdk` for the current worker backend. Our `runTurn`
contract drives one unattended turn, persists its resume token, and reports
events through the existing worker channel. This matches the SDK's supported
automation use case. It does not need a human approval exchange inside Codex.
See the [Codex SDK guide](https://learn.chatgpt.com/docs/codex-sdk).

App Server is a candidate for a future interactive backend, not a prerequisite
for fixing the current worker. It exposes authentication, thread history,
approval requests, and richer event handling. Its dynamic tool interface and
externally managed ChatGPT token interface are experimental. Migrating now
would add a JSON-RPC process lifecycle and request dispatcher without removing
our need to authorize tools on the control plane. See
[App Server](https://learn.chatgpt.com/docs/app-server).

Revisit this decision when the product needs interactive approvals or native
Codex history/auth management. A migration should preserve the neutral backend
contract, interceptors, cancellation, resume compatibility, and worker-channel
authorization; exercise those against the pinned CLI before rollout. Existing
`codex:` resume tokens must remain usable or receive an explicit recovery path.

## Tools and unattended approvals

The adapter starts a loopback Streamable HTTP MCP bridge per turn and gives
the CLI a random bearer token through its environment. Tool execution passes
through extension interceptors and, for orch operations, the worker channel's
control-plane authorization. Workers do not access Postgres directly.

The `task_orch` MCP server is required and has a 30-second startup timeout.
It uses `default_tools_approval_mode = "approve"` because the session has
`approvalPolicy = "never"`: that session setting does not itself approve MCP
calls. Without the server setting, an MCP call can be rejected because it
would require a prompt. This configuration applies to our registered bridge.
See [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Tool-discovery guidance is repeated on resumed turns so an old transcript
claiming tools are unavailable does not strand the run on the repository CLI.

## Sprite filesystem policy

Sprite workers use `danger-full-access` by default inside their isolated VM;
local Codex runs retain the `workspace-write` default. Sprite dispatch forwards
an explicit `TASK_ORCH_CODEX_SANDBOX` override. The VM is the filesystem
isolation boundary for the default Sprite configuration: do not rely on Codex
to restrict writes to the checkout there.

The nested Linux sandbox failed on Sprite with
`bwrap: Unexpected capabilities but not setuid, old file caps config?`.
Selecting a policy that works on the actual runner is necessary even when the
model and MCP transport are healthy. Broader access is appropriate only for a
controlled isolated runner, as described in
[non-interactive permissions](https://learn.chatgpt.com/docs/non-interactive-mode#permissions-and-safety).

## Verification contract

Mocked SDK tests cover adapter state transitions, retries, and cancellation.
MCP-client tests cover bridge authentication, validation, and interceptors.
Real-CLI tests must also execute an MCP tool through Codex, with a local mock
Responses endpoint and fake credentials, to catch configuration mismatches
that the other two layers cannot observe. Cover fresh and resumed turns and
terminal failures; a reconnect warning alone is not terminal failure.

Keep SDK and Sprite CLI versions aligned. A passing import or `codex --version`
check is not an adequate smoke test for tool execution.

The general [Codex best practices guide](https://learn.chatgpt.com/guides/best-practices)
also recommends practical repository instructions, explicit completion criteria,
and validation against the actual environment. Maintain runner-specific traps
in [agent-caveats.md](agent-caveats.md).
