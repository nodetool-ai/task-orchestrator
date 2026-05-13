// gh_pr MCP server: thin wrappers around the `gh` CLI for PR operations.
// Mounted by lib/runs.ts when a run's tools_profile includes 'gh_pr'.
//
// Every tool here parses a PR URL (or short form like owner/repo#N) and
// validates the owner/repo against the orchestrator's registered repos before
// shelling out to `gh`. The point of the gate is twofold: (1) we don't want
// an agent reviewing or merging PRs in repos we don't own; (2) it produces
// crisp error messages instead of opaque `gh` failures when an agent
// hallucinates a URL.
//
// `gh` is executed with `cwd` set to the run's resolved repo path. `gh` will
// happily operate on any URL regardless of cwd, but having a real git
// checkout in cwd lets `gh` resolve auth/config the same way an interactive
// shell would.

import { spawn } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  ownerRepoFromRemote,
  parsePrUrl,
  validatePrUrl,
  type ParsedPrUrl,
  type UrlValidation,
} from "./gh-url";

// Re-export URL helpers so existing imports (`from './gh-pr-mcp'`) keep
// working after the split into lib/gh-url.ts.
export { ownerRepoFromRemote, parsePrUrl, validatePrUrl };
export type { ParsedPrUrl, UrlValidation };

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

function gh(args: string[], cwd: string | undefined): Promise<GhResult> {
  return new Promise((resolveP) => {
    const child = spawn("gh", args, { env: process.env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolveP({ code: -1, stdout, stderr: stderr + String(err) })
    );
    child.on("close", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ──────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────

export interface GhPrServerOptions {
  /** cwd for the `gh` subprocess. Defaults to undefined (inherits process cwd). */
  cwd?: string;
}

export function createGhPrMcpServer(options: GhPrServerOptions = {}) {
  const cwd = options.cwd;

  // Small helper: gate every tool on URL validation.
  function gate(url: string):
    | { ok: true; parsed: ParsedPrUrl; matched: { id: string; name: string } }
    | { ok: false; result: ReturnType<typeof errResult> } {
    const v = validatePrUrl(url);
    if ("error" in v) return { ok: false, result: errResult(v.error) };
    return { ok: true, parsed: v.parsed, matched: v.matched };
  }

  return createSdkMcpServer({
    name: "gh_pr",
    version: "0.2.0",
    tools: [
      tool(
        "pr_view",
        "Fetch a PR's metadata: state, mergeable, CI status, title, body, files. Pass the PR URL (https://github.com/<owner>/<repo>/pull/<n>) or short form (owner/repo#n).",
        { url: z.string().min(1) },
        async ({ url }) => {
          const g = gate(url);
          if (!g.ok) return g.result;
          const fields =
            "state,mergeable,mergeStateStatus,title,body,url,number,headRefName,baseRefName,author,createdAt,updatedAt,mergedAt,files,statusCheckRollup,isDraft,additions,deletions,changedFiles";
          const r = await gh(["pr", "view", g.parsed.canonical, "--json", fields], cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh pr view failed (exit ${r.code})`);
          }
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(r.stdout) as Record<string, unknown>;
          } catch {
            return errResult(`gh pr view returned non-JSON: ${r.stdout.slice(0, 200)}`);
          }
          // Roll up CI: collapse statusCheckRollup into a single summary string.
          const checks = Array.isArray(raw.statusCheckRollup)
            ? (raw.statusCheckRollup as Array<Record<string, unknown>>)
            : [];
          const ciStatus = summarizeChecks(checks);
          const payload = {
            url: raw.url ?? g.parsed.canonical,
            number: raw.number ?? g.parsed.number,
            state: raw.state ?? null,
            mergeable: raw.mergeable ?? null,
            merge_state_status: raw.mergeStateStatus ?? null,
            ci_status: ciStatus,
            title: raw.title ?? null,
            body: raw.body ?? null,
            head_ref: raw.headRefName ?? null,
            base_ref: raw.baseRefName ?? null,
            author: raw.author ?? null,
            is_draft: raw.isDraft ?? null,
            additions: raw.additions ?? null,
            deletions: raw.deletions ?? null,
            changed_files: raw.changedFiles ?? null,
            files: Array.isArray(raw.files) ? raw.files : [],
            repo: g.matched,
          };
          return ok(JSON.stringify(payload, null, 2));
        }
      ),
      tool(
        "pr_diff",
        "Fetch the diff for a PR. If `file` is provided, the diff is filtered to that path.",
        { url: z.string().min(1), file: z.string().optional() },
        async ({ url, file }) => {
          const g = gate(url);
          if (!g.ok) return g.result;
          const r = await gh(["pr", "diff", g.parsed.canonical], cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh pr diff failed (exit ${r.code})`);
          }
          if (!file) return ok(r.stdout);
          const filtered = filterDiffByFile(r.stdout, file);
          if (!filtered) {
            return errResult(`No diff hunks for file '${file}' in PR ${g.parsed.canonical}.`);
          }
          return ok(filtered);
        }
      ),
      tool(
        "pr_review",
        "Post a PR review. verdict='approve' approves, 'comment' leaves a top-level review comment, 'request_changes' requests changes. body is required for comment/request_changes; optional for approve.",
        {
          url: z.string().min(1),
          verdict: z.enum(["approve", "comment", "request_changes"]),
          body: z.string().optional(),
        },
        async ({ url, verdict, body }) => {
          const g = gate(url);
          if (!g.ok) return g.result;
          if ((verdict === "comment" || verdict === "request_changes") && !body?.trim()) {
            return errResult(`verdict='${verdict}' requires a non-empty body.`);
          }
          const args = ["pr", "review", g.parsed.canonical];
          if (verdict === "approve") args.push("--approve");
          else if (verdict === "comment") args.push("--comment");
          else args.push("--request-changes");
          if (body && body.length > 0) args.push("--body", body);
          const r = await gh(args, cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh pr review failed (exit ${r.code})`);
          }
          return ok(
            JSON.stringify(
              {
                ok: true,
                verdict,
                pr: g.parsed.canonical,
                stdout: r.stdout.trim(),
              },
              null,
              2
            )
          );
        }
      ),
      tool(
        "pr_comment",
        "Post a comment on a PR. If `line` and `file` are both provided, posts an inline review comment on that line; otherwise posts a top-level PR comment.",
        {
          url: z.string().min(1),
          body: z.string().min(1),
          line: z.number().int().positive().optional(),
          file: z.string().optional(),
        },
        async ({ url, body, line, file }) => {
          const g = gate(url);
          if (!g.ok) return g.result;
          const inline = line !== undefined && file !== undefined && file.length > 0;
          if ((line !== undefined) !== (file !== undefined && file.length > 0)) {
            return errResult(
              "Inline comments require both `line` and `file`. To leave a top-level comment, omit both."
            );
          }
          if (inline) {
            // gh CLI doesn't support inline review comments directly. Fall
            // back to the REST API via `gh api`. We need the head commit SHA
            // first; fetch it via pr view.
            const head = await gh(
              ["pr", "view", g.parsed.canonical, "--json", "headRefOid"],
              cwd
            );
            if (head.code !== 0) {
              return errResult(
                head.stderr.trim() || `gh pr view (for headRefOid) failed (exit ${head.code})`
              );
            }
            let commitId: string | null = null;
            try {
              const parsed = JSON.parse(head.stdout) as { headRefOid?: string };
              commitId = parsed.headRefOid ?? null;
            } catch {
              return errResult(`Could not parse headRefOid from gh pr view output.`);
            }
            if (!commitId) {
              return errResult(`PR ${g.parsed.canonical} has no headRefOid; can't inline-comment.`);
            }
            const apiPath = `repos/${g.parsed.owner}/${g.parsed.repo}/pulls/${g.parsed.number}/comments`;
            const args = [
              "api",
              "--method",
              "POST",
              apiPath,
              "-f",
              `body=${body}`,
              "-f",
              `commit_id=${commitId}`,
              "-f",
              `path=${file}`,
              "-F",
              `line=${line}`,
              "-f",
              "side=RIGHT",
            ];
            const r = await gh(args, cwd);
            if (r.code !== 0) {
              return errResult(r.stderr.trim() || `gh api (inline comment) failed (exit ${r.code})`);
            }
            return ok(
              JSON.stringify(
                { ok: true, kind: "inline", pr: g.parsed.canonical, file, line, response: tryParseJson(r.stdout) },
                null,
                2
              )
            );
          }
          // Top-level PR comment
          const r = await gh(["pr", "comment", g.parsed.canonical, "--body", body], cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh pr comment failed (exit ${r.code})`);
          }
          return ok(
            JSON.stringify(
              { ok: true, kind: "top_level", pr: g.parsed.canonical, stdout: r.stdout.trim() },
              null,
              2
            )
          );
        }
      ),
      tool(
        "pr_merge",
        "Merge a PR. method='merge' creates a merge commit, 'squash' squashes commits, 'rebase' rebases.",
        {
          url: z.string().min(1),
          method: z.enum(["merge", "squash", "rebase"]),
        },
        async ({ url, method }) => {
          const g = gate(url);
          if (!g.ok) return g.result;
          const args = ["pr", "merge", g.parsed.canonical];
          if (method === "merge") args.push("--merge");
          else if (method === "squash") args.push("--squash");
          else args.push("--rebase");
          const r = await gh(args, cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh pr merge failed (exit ${r.code})`);
          }
          return ok(
            JSON.stringify(
              { ok: true, method, pr: g.parsed.canonical, stdout: r.stdout.trim() },
              null,
              2
            )
          );
        }
      ),
    ],
  });
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Collapse the `statusCheckRollup` array from `gh pr view --json` into a
// single SUCCESS / FAILURE / PENDING / NEUTRAL summary, with a count
// breakdown. Empty rollup → "NONE".
function summarizeChecks(checks: Array<Record<string, unknown>>): {
  state: "SUCCESS" | "FAILURE" | "PENDING" | "NEUTRAL" | "NONE";
  total: number;
  success: number;
  failure: number;
  pending: number;
  neutral: number;
} {
  let success = 0;
  let failure = 0;
  let pending = 0;
  let neutral = 0;
  for (const c of checks) {
    // GitHub check runs use `conclusion` (success, failure, neutral, cancelled,
    // timed_out, action_required, skipped) when complete and `status` (queued,
    // in_progress, completed) for state. Status checks (legacy) use `state`
    // (SUCCESS, FAILURE, PENDING, ERROR).
    const status = (c.status as string | undefined)?.toUpperCase();
    const conclusion = (c.conclusion as string | undefined)?.toUpperCase();
    const state = (c.state as string | undefined)?.toUpperCase();
    if (status && status !== "COMPLETED") {
      pending += 1;
      continue;
    }
    const verdict = conclusion ?? state;
    if (!verdict) {
      neutral += 1;
      continue;
    }
    if (verdict === "SUCCESS") success += 1;
    else if (
      verdict === "FAILURE" ||
      verdict === "ERROR" ||
      verdict === "TIMED_OUT" ||
      verdict === "CANCELLED" ||
      verdict === "ACTION_REQUIRED"
    )
      failure += 1;
    else if (verdict === "PENDING" || verdict === "IN_PROGRESS" || verdict === "QUEUED")
      pending += 1;
    else neutral += 1;
  }
  const total = checks.length;
  let stateOut: "SUCCESS" | "FAILURE" | "PENDING" | "NEUTRAL" | "NONE";
  if (total === 0) stateOut = "NONE";
  else if (failure > 0) stateOut = "FAILURE";
  else if (pending > 0) stateOut = "PENDING";
  else if (success > 0) stateOut = "SUCCESS";
  else stateOut = "NEUTRAL";
  return { state: stateOut, total, success, failure, pending, neutral };
}

// Filter a unified diff to only the hunks affecting the given file path.
// Matches against both the `a/` and `b/` paths in `diff --git` headers.
export function filterDiffByFile(diff: string, file: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  const out: string[] = [];
  let keeping = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // diff --git a/<path> b/<path>
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        keeping = m[1] === file || m[2] === file;
      } else {
        keeping = false;
      }
    }
    if (keeping) out.push(line);
  }
  return out.join("\n");
}
