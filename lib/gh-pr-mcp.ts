// gh_pr MCP server: thin wrappers around the `gh` CLI for PR operations.
// Mounted by lib/runs.ts when a run's tools_profile includes 'gh_pr'.
//
// Today this exposes the minimum we need for resumable runs to inspect and
// comment on the PR they created. It's deliberately small — adding tools is
// cheap, removing them is not.

import { spawn } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

function gh(args: string[]): Promise<GhResult> {
  return new Promise((resolveP) => {
    const child = spawn("gh", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolveP({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createGhPrMcpServer() {
  return createSdkMcpServer({
    name: "gh_pr",
    version: "0.1.0",
    tools: [
      tool(
        "view",
        "Fetch a PR's metadata as JSON. `pr` is a URL, owner/repo#number, or branch name.",
        { pr: z.string().min(1), fields: z.string().optional() },
        async ({ pr, fields }) => {
          const wanted =
            fields ??
            "number,title,state,url,headRefName,baseRefName,author,mergedAt,createdAt,updatedAt,body";
          const r = await gh(["pr", "view", pr, "--json", wanted]);
          if (r.code !== 0) return err(r.stderr.trim() || `gh pr view failed (exit ${r.code})`);
          return ok(r.stdout.trim());
        }
      ),
      tool(
        "list",
        "List PRs in the current repo. State is 'open' (default), 'closed', 'merged', or 'all'.",
        { state: z.enum(["open", "closed", "merged", "all"]).optional(), limit: z.number().int().optional() },
        async ({ state, limit }) => {
          const args = ["pr", "list", "--json", "number,title,state,url,headRefName,author"];
          if (state) args.push("--state", state);
          if (limit) args.push("--limit", String(limit));
          const r = await gh(args);
          if (r.code !== 0) return err(r.stderr.trim() || `gh pr list failed (exit ${r.code})`);
          return ok(r.stdout.trim());
        }
      ),
      tool(
        "comment",
        "Add a comment to a PR.",
        { pr: z.string().min(1), body: z.string().min(1) },
        async ({ pr, body }) => {
          const r = await gh(["pr", "comment", pr, "--body", body]);
          if (r.code !== 0) return err(r.stderr.trim() || `gh pr comment failed (exit ${r.code})`);
          return ok(r.stdout.trim() || "Comment posted.");
        }
      ),
      tool(
        "checks",
        "Show CI check results for a PR.",
        { pr: z.string().min(1) },
        async ({ pr }) => {
          const r = await gh(["pr", "checks", pr]);
          if (r.code !== 0) return err(r.stderr.trim() || `gh pr checks failed (exit ${r.code})`);
          return ok(r.stdout.trim() || "(no output)");
        }
      ),
    ],
  });
}
