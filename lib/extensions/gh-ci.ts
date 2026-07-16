// lib/extensions/gh-ci.ts
//
// gh_ci extension: pi-side replacement for lib/gh-ci-mcp.ts. Tools are
// flat-namespaced as gh_ci__<name>. GitHub Actions I/O runs in-process through
// the orchestrator's Octokit client (lib/github-client.ts) rather than shelling
// out to the `gh` CLI.

import { Type } from "typebox";
import { validatePrUrl, type ParsedPrUrl } from "../gh-url";
import { legacyRepoRemotes } from "./legacy-invoker";
import { getOctokit, describeGithubError } from "../github-client";
import type { ExtensionFactory } from "./types";
import type { RepoRemotesFn } from "./gh-pr";

const ok = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

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
// Extension
// ──────────────────────────────────────────────────────────

export interface GhCiExtensionOptions {
  /** Retained for API compatibility; GitHub I/O no longer uses a subprocess cwd. */
  cwd?: string;
  /** Repo-remote lookup seam (plan section 15); defaults to the legacy transport. */
  listRepoRemotes?: RepoRemotesFn;
}

/** Failure-ish conclusions that make a job "failed" for --log-failed semantics. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

export const ghCiExtension =
  (opts: GhCiExtensionOptions = {}): ExtensionFactory =>
  (reg) => {
    const listRepoRemotes = opts.listRepoRemotes ?? legacyRepoRemotes();
    async function gate(url: string): Promise<
      | { ok: true; parsed: ParsedPrUrl; matched: { id: string; name: string } }
      | { ok: false; result: ReturnType<typeof errResult> }
    > {
      // Repo-remote gating reads through the injected seam so a ws worker never
      // touches the repositories table directly.
      const v = await validatePrUrl(url, listRepoRemotes);
      if ("error" in v) return { ok: false, result: errResult(v.error) };
      return { ok: true, parsed: v.parsed, matched: v.matched };
    }

    reg.registerTool({
      name: "gh_ci__ci_runs",
      label: "CI Runs",
      description:
        "List GitHub Actions workflow runs for a PR. Resolves the PR's head ref first, then returns runs on that branch with id, name, status, conclusion, url, head sha, and created timestamp.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execute: async (_id, { url, limit }) => {
        const g = await gate(url);
        if (!g.ok) return g.result;
        const { owner, repo, number } = g.parsed;

        const octokit = getOctokit();
        // 1. Resolve the head ref.
        let headRef: string | null = null;
        try {
          const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
          headRef = (pr.head as { ref?: string } | null)?.ref ?? null;
        } catch (err) {
          return errResult(describeGithubError(err) || "gh pr view failed");
        }
        if (!headRef) {
          return errResult(
            `PR ${g.parsed.canonical} has no headRefName; cannot list runs.`
          );
        }

        // 2. List runs on that branch.
        let rawRuns: Array<Record<string, unknown>>;
        try {
          const { data } = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            branch: headRef,
            per_page: limit ?? 20,
          });
          rawRuns = (data.workflow_runs ?? []) as Array<Record<string, unknown>>;
        } catch (err) {
          return errResult(describeGithubError(err) || "gh run list failed");
        }
        const runs = rawRuns.slice(0, limit ?? 20).map((r) => ({
          id: r.id ?? null,
          name: r.name ?? null,
          workflow_name: r.name ?? null,
          status: r.status ?? null,
          conclusion: r.conclusion ?? null,
          url: r.html_url ?? null,
          head_sha: r.head_sha ?? null,
          event: r.event ?? null,
          created_at: r.created_at ?? null,
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
      },
    });

    reg.registerTool({
      name: "gh_ci__ci_logs",
      label: "CI Logs",
      description:
        "Fetch trimmed logs for a workflow run. Pass the PR URL (for repo gating) and the run id. If `job` is given, scopes to that job. By default returns only failed-step logs; set `mode='full'` to fetch full logs (still trimmed to the last ~500 lines / 50KB).",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        run_id: Type.Union([
          Type.Integer({ minimum: 1 }),
          Type.String({ minLength: 1 }),
        ]),
        job: Type.Optional(Type.String()),
        mode: Type.Optional(
          Type.Union([Type.Literal("failed"), Type.Literal("full")])
        ),
      }),
      execute: async (_id, { url, run_id, job, mode }) => {
        // Validate run_id is numeric (kept from the CLI era to reject junk early).
        if (!/^\d+$/.test(String(run_id))) {
          return errResult(`run_id must be a numeric value, got: ${run_id}`);
        }

        const g = await gate(url);
        if (!g.ok) return g.result;
        const { owner, repo } = g.parsed;
        const runId = Number(run_id);
        const effectiveMode = mode ?? "failed";
        const octokit = getOctokit();

        // List the run's jobs; filter to a specific job when requested (by id or name).
        let jobs: Array<Record<string, unknown>>;
        try {
          jobs = (await octokit.paginate(octokit.actions.listJobsForWorkflowRun, {
            owner,
            repo,
            run_id: runId,
            per_page: 100,
          })) as Array<Record<string, unknown>>;
        } catch (err) {
          return errResult(describeGithubError(err) || "gh run view failed");
        }
        if (job && job.length > 0) {
          jobs = jobs.filter(
            (j) => String(j.id) === job || String(j.name) === job
          );
        }

        async function collectLogs(selected: Array<Record<string, unknown>>): Promise<string> {
          const chunks: string[] = [];
          for (const j of selected) {
            try {
              const res = await octokit.actions.downloadJobLogsForWorkflowRun({
                owner,
                repo,
                job_id: Number(j.id),
              });
              const text =
                typeof res.data === "string"
                  ? res.data
                  : Buffer.isBuffer(res.data)
                    ? res.data.toString("utf8")
                    : res.data instanceof ArrayBuffer
                      ? Buffer.from(res.data).toString("utf8")
                      : String(res.data ?? "");
              chunks.push(`==> ${j.name} <==\n${text}`);
            } catch {
              // Best-effort per job — skip logs we can't fetch.
            }
          }
          return chunks.join("\n");
        }

        // Failed mode: only the failed jobs' logs. gh's --log-failed exits 0
        // even when nothing failed (in-progress / green run) → fall back to the
        // full log so the agent sees something instead of a blank success.
        if (effectiveMode === "failed") {
          const failedJobs = jobs.filter((j) =>
            FAILED_CONCLUSIONS.has(String(j.conclusion ?? "").toLowerCase())
          );
          const failedLog = await collectLogs(failedJobs);
          if (failedLog.trim()) return ok(trimLog(failedLog));
          const fullLog = await collectLogs(jobs);
          return ok(trimLog(fullLog));
        }

        const fullLog = await collectLogs(jobs);
        return ok(trimLog(fullLog));
      },
    });

    reg.registerTool({
      name: "gh_ci__ci_rerun",
      label: "CI Rerun",
      description:
        "Trigger a fresh workflow run. By default re-runs everything; set failed_only=true to re-run only failed jobs (`gh run rerun --failed`). Returns the new run's url (best-effort: looks it up after triggering).",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        run_id: Type.Union([
          Type.Integer({ minimum: 1 }),
          Type.String({ minLength: 1 }),
        ]),
        failed_only: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, { url, run_id, failed_only }) => {
        // Validate run_id is numeric.
        if (!/^\d+$/.test(String(run_id))) {
          return errResult(`run_id must be a numeric value, got: ${run_id}`);
        }

        const g = await gate(url);
        if (!g.ok) return g.result;
        const { owner, repo } = g.parsed;
        const runId = Number(run_id);
        const octokit = getOctokit();

        try {
          if (failed_only) {
            await octokit.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
          } else {
            await octokit.actions.reRunWorkflow({ owner, repo, run_id: runId });
          }
        } catch (err) {
          return errResult(describeGithubError(err) || "gh run rerun failed");
        }

        // A re-run reuses the same run id (a new attempt), so the run's own url
        // is the "new" run url. Best-effort — the rerun already succeeded.
        let newUrl: string | null = null;
        let workflowName: string | null = null;
        try {
          const { data: run } = await octokit.actions.getWorkflowRun({
            owner,
            repo,
            run_id: runId,
          });
          newUrl = (run.html_url as string) ?? null;
          workflowName = (run.name as string) ?? null;
        } catch {
          // Best-effort.
        }

        return ok(
          JSON.stringify(
            {
              ok: true,
              rerun_of: String(run_id),
              failed_only: !!failed_only,
              workflow_name: workflowName,
              new_run_url: newUrl,
              stdout: `Re-run triggered for run ${run_id}`,
            },
            null,
            2
          )
        );
      },
    });
  };
