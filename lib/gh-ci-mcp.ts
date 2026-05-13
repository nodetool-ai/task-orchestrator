// gh_ci MCP server: thin wrappers around the `gh` CLI for CI / workflow run
// operations. Mounted by lib/runs.ts when a run's tools_profile includes
// 'gh_ci'.
//
// Like gh_pr, every tool here gates on the orchestrator's repo registry:
// the agent has to pass a PR URL that resolves to a known repo before we
// shell out to `gh`. This keeps an agent from poking at CI runs in repos
// the orchestrator doesn't own, and produces clearer errors when an agent
// hallucinates a URL.
//
// `gh` is executed with `cwd` set to the run's resolved repo path so it
// picks up the same auth/config an interactive shell would.

import { spawn } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { validatePrUrl, type ParsedPrUrl } from "./gh-url";

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
// Log trimming
// ──────────────────────────────────────────────────────────

/** Soft caps to keep tool output well under MCP response limits. */
export const MAX_LOG_LINES = 500;
export const MAX_LOG_BYTES = 50 * 1024; // ~50KB

/**
 * Trim a workflow log to a useful tail. Strategy:
 *   1. If the raw log already fits in `maxLines` and `maxBytes`, return as-is.
 *   2. Otherwise, take the last `maxLines` lines.
 *   3. If the result still exceeds `maxBytes`, drop leading lines until it
 *      fits (or, in the pathological "single huge line" case, slice the
 *      trailing `maxBytes` bytes).
 *   4. Prepend a single header line noting how many lines were dropped, so
 *      the agent knows the output is truncated.
 *
 * Pure function — no I/O — so it's the natural unit to test.
 */
export function trimLog(
  raw: string,
  opts: { maxLines?: number; maxBytes?: number } = {}
): string {
  const maxLines = opts.maxLines ?? MAX_LOG_LINES;
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
  if (!raw) return "";

  const lines = raw.split("\n");
  const totalLines = lines.length;
  const byteLen = Buffer.byteLength(raw, "utf8");

  if (totalLines <= maxLines && byteLen <= maxBytes) {
    return raw;
  }

  // Take the tail by line count first.
  let kept = lines.slice(-maxLines);
  let dropped = totalLines - kept.length;

  // If still over the byte budget, drop from the front line-by-line.
  let assembled = kept.join("\n");
  while (Buffer.byteLength(assembled, "utf8") > maxBytes && kept.length > 1) {
    kept = kept.slice(1);
    dropped += 1;
    assembled = kept.join("\n");
  }

  // Pathological single-line case: just slice the trailing bytes.
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    const buf = Buffer.from(assembled, "utf8");
    assembled = buf.slice(buf.length - maxBytes).toString("utf8");
  }

  const header =
    dropped > 0
      ? `[trimmed: showing last ${kept.length} of ${totalLines} lines; ${dropped} dropped]`
      : `[trimmed: showing last ${kept.length} lines]`;
  return `${header}\n${assembled}`;
}

// ──────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────

export interface GhCiServerOptions {
  /** cwd for the `gh` subprocess. Defaults to undefined (inherits process cwd). */
  cwd?: string;
}

export function createGhCiMcpServer(options: GhCiServerOptions = {}) {
  const cwd = options.cwd;

  // Same gate as gh_pr: validate the URL maps to a registered repo before
  // doing anything else. Returns the parsed URL on success or an error
  // result that can be returned directly from a tool handler.
  function gate(url: string):
    | { ok: true; parsed: ParsedPrUrl; matched: { id: string; name: string } }
    | { ok: false; result: ReturnType<typeof errResult> } {
    const v = validatePrUrl(url);
    if ("error" in v) return { ok: false, result: errResult(v.error) };
    return { ok: true, parsed: v.parsed, matched: v.matched };
  }

  return createSdkMcpServer({
    name: "gh_ci",
    version: "0.1.0",
    tools: [
      tool(
        "ci_runs",
        "List GitHub Actions workflow runs for a PR. Resolves the PR's head ref first, then returns runs on that branch with id, name, status, conclusion, url, head sha, and created timestamp.",
        { url: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
        async ({ url, limit }) => {
          const g = gate(url);
          if (!g.ok) return g.result;

          // 1. Resolve the head ref via gh pr view.
          const prView = await gh(
            ["pr", "view", g.parsed.canonical, "--json", "headRefName"],
            cwd
          );
          if (prView.code !== 0) {
            return errResult(
              prView.stderr.trim() || `gh pr view failed (exit ${prView.code})`
            );
          }
          let headRef: string | null = null;
          try {
            const parsed = JSON.parse(prView.stdout) as { headRefName?: string };
            headRef = parsed.headRefName ?? null;
          } catch {
            return errResult(
              `gh pr view returned non-JSON: ${prView.stdout.slice(0, 200)}`
            );
          }
          if (!headRef) {
            return errResult(
              `PR ${g.parsed.canonical} has no headRefName; cannot list runs.`
            );
          }

          // 2. List runs on that branch. `gh run list` honours cwd's repo by
          // default; pass --repo explicitly so it works regardless of cwd.
          const runsArgs = [
            "run",
            "list",
            "--repo",
            `${g.parsed.owner}/${g.parsed.repo}`,
            "--branch",
            headRef,
            "--limit",
            String(limit ?? 20),
            "--json",
            "databaseId,name,status,conclusion,url,headSha,createdAt,workflowName,event",
          ];
          const runsResult = await gh(runsArgs, cwd);
          if (runsResult.code !== 0) {
            return errResult(
              runsResult.stderr.trim() || `gh run list failed (exit ${runsResult.code})`
            );
          }
          let raw: Array<Record<string, unknown>>;
          try {
            raw = JSON.parse(runsResult.stdout) as Array<Record<string, unknown>>;
          } catch {
            return errResult(
              `gh run list returned non-JSON: ${runsResult.stdout.slice(0, 200)}`
            );
          }
          // Normalise field naming (`databaseId` → `id`).
          const runs = raw.map((r) => ({
            id: r.databaseId ?? null,
            name: r.name ?? null,
            workflow_name: r.workflowName ?? null,
            status: r.status ?? null,
            conclusion: r.conclusion ?? null,
            url: r.url ?? null,
            head_sha: r.headSha ?? null,
            event: r.event ?? null,
            created_at: r.createdAt ?? null,
          }));
          return ok(
            JSON.stringify(
              {
                pr: g.parsed.canonical,
                head_ref: headRef,
                count: runs.length,
                runs,
              },
              null,
              2
            )
          );
        }
      ),
      tool(
        "ci_logs",
        "Fetch trimmed logs for a workflow run. Pass the PR URL (for repo gating) and the run id. If `job` is given, scopes to that job. By default returns only failed-step logs; set `mode='full'` to fetch full logs (still trimmed to the last ~500 lines / 50KB).",
        {
          url: z.string().min(1),
          run_id: z.union([z.number().int().positive(), z.string().min(1)]),
          job: z.string().optional(),
          mode: z.enum(["failed", "full"]).optional(),
        },
        async ({ url, run_id, job, mode }) => {
          const g = gate(url);
          if (!g.ok) return g.result;

          const effectiveMode = mode ?? "failed";
          const args = [
            "run",
            "view",
            String(run_id),
            "--repo",
            `${g.parsed.owner}/${g.parsed.repo}`,
          ];
          if (effectiveMode === "failed") args.push("--log-failed");
          else args.push("--log");
          if (job && job.length > 0) args.push("--job", job);

          const r = await gh(args, cwd);
          // `gh run view --log-failed` exits 0 even when there are no failed
          // steps (returns an empty body). We surface stderr as an error only
          // when exit code is non-zero.
          if (r.code !== 0) {
            // Special-case: if --log-failed produced no output (e.g. no failed
            // steps yet), fall back to --log so the agent still sees something.
            if (effectiveMode === "failed" && !r.stdout.trim()) {
              const fallbackArgs = [
                "run",
                "view",
                String(run_id),
                "--repo",
                `${g.parsed.owner}/${g.parsed.repo}`,
                "--log",
              ];
              if (job && job.length > 0) fallbackArgs.push("--job", job);
              const fb = await gh(fallbackArgs, cwd);
              if (fb.code !== 0) {
                return errResult(
                  fb.stderr.trim() || `gh run view failed (exit ${fb.code})`
                );
              }
              return ok(trimLog(fb.stdout));
            }
            return errResult(r.stderr.trim() || `gh run view failed (exit ${r.code})`);
          }
          return ok(trimLog(r.stdout));
        }
      ),
      tool(
        "ci_rerun",
        "Trigger a fresh workflow run. By default re-runs everything; set failed_only=true to re-run only failed jobs (`gh run rerun --failed`). Returns the new run's url (best-effort: looks it up via `gh run list` after triggering).",
        {
          url: z.string().min(1),
          run_id: z.union([z.number().int().positive(), z.string().min(1)]),
          failed_only: z.boolean().optional(),
        },
        async ({ url, run_id, failed_only }) => {
          const g = gate(url);
          if (!g.ok) return g.result;

          const repoFlag = ["--repo", `${g.parsed.owner}/${g.parsed.repo}`];
          const rerunArgs = ["run", "rerun", String(run_id), ...repoFlag];
          if (failed_only) rerunArgs.push("--failed");

          const r = await gh(rerunArgs, cwd);
          if (r.code !== 0) {
            return errResult(r.stderr.trim() || `gh run rerun failed (exit ${r.code})`);
          }

          // gh run rerun doesn't print the new run URL. Best-effort: pull
          // the workflow name from the original run, then list the most
          // recent run for that workflow on the PR's head ref.
          let newUrl: string | null = null;
          let workflowName: string | null = null;
          try {
            const view = await gh(
              [
                "run",
                "view",
                String(run_id),
                ...repoFlag,
                "--json",
                "workflowName,headBranch",
              ],
              cwd
            );
            if (view.code === 0) {
              const parsed = JSON.parse(view.stdout) as {
                workflowName?: string;
                headBranch?: string;
              };
              workflowName = parsed.workflowName ?? null;
              const branch = parsed.headBranch;
              if (workflowName && branch) {
                const list = await gh(
                  [
                    "run",
                    "list",
                    ...repoFlag,
                    "--workflow",
                    workflowName,
                    "--branch",
                    branch,
                    "--limit",
                    "1",
                    "--json",
                    "url,databaseId,createdAt",
                  ],
                  cwd
                );
                if (list.code === 0) {
                  const arr = JSON.parse(list.stdout) as Array<{ url?: string }>;
                  if (arr.length > 0 && arr[0].url) newUrl = arr[0].url;
                }
              }
            }
          } catch {
            // Best-effort — original rerun already succeeded.
          }

          return ok(
            JSON.stringify(
              {
                ok: true,
                rerun_of: String(run_id),
                failed_only: !!failed_only,
                workflow_name: workflowName,
                new_run_url: newUrl,
                stdout: r.stdout.trim(),
              },
              null,
              2
            )
          );
        }
      ),
    ],
  });
}
