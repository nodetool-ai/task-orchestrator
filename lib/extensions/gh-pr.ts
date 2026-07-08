// lib/extensions/gh-pr.ts
//
// gh_pr extension: pi-side replacement for lib/gh-pr-mcp.ts. Tools are
// flat-namespaced as gh_pr__<name>. Helpers come over verbatim from the
// old file.

import { spawn } from "node:child_process";
import { Type } from "typebox";
import {
  ownerRepoFromRemote,
  parsePrUrl,
  validatePrUrl,
  type ParsedPrUrl,
  type UrlValidation,
} from "../gh-url";
import { runTransport } from "@/lib/worker";
import type { BackendRegistrar, ExtensionFactory } from "./types";

// Re-export so consumers importing 'lib/extensions/gh-pr' get the URL helpers too.
export { ownerRepoFromRemote, parsePrUrl, validatePrUrl };
export type { ParsedPrUrl, UrlValidation };

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Timeout for gh subprocess calls (seconds). Prevents indefinite hangs on network issues.
const GH_TIMEOUT_SECONDS = 120;

function gh(args: string[], cwd: string | undefined): Promise<GhResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("gh", args, { env: process.env, cwd });
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const settle = (result: GhResult) => {
      if (!resolved) {
        resolved = true;
        resolveP(result);
      }
    };

    // Set a timeout to kill the process if it hangs.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        code: -1,
        stdout,
        stderr: stderr + `\ngh ${args[0]} timed out after ${GH_TIMEOUT_SECONDS}s`,
      });
    }, GH_TIMEOUT_SECONDS * 1000);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code: code ?? -1, stdout, stderr });
    });
  });
}

const ok = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

export interface GhPrExtensionOptions {
  cwd?: string;
  /** Registered repository remote. Lets lightweight chat use GitHub tools even
   *  when there is no local checkout to run gh from. */
  remote?: string | null;
  /** Caller's run id, used by the resource-lock guard (docs/agent-events.md
   *  §5.2) on mutating tools (merge, approve). Required for ghPrExtension;
   *  unused by ghPrReadOnlyExtension (no merge tool, approve excluded). */
  runId?: number;
}

function repoFullName(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const parsed = ownerRepoFromRemote(remote);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

function repoFlag(fullName: string | null): string[] {
  return fullName ? ["--repo", fullName] : [];
}

/**
 * Resource-lock guard (§5.2): a `pr:<url>` lease answers "who owns this PR"
 * with a single primary-key lookup instead of a subtree walk per mutating
 * call. Locked by a live run that isn't the caller -> refuse, naming the
 * owner. Unlocked, or locked by a run that has since gone terminal -> proceed
 * and take/refresh the lease for the caller. One shared helper so both
 * pr_merge and the approving pr_review branch enforce the exact same rule.
 * The lease itself lives on the orchestrator (transport.acquirePrLock —
 * workers hold no database access); only the `gh` shell-outs run locally.
 */
async function checkAndAcquirePrLock(
  prUrl: string,
  runId: number | undefined
): Promise<{ ok: true } | { ok: false; result: ReturnType<typeof errResult> }> {
  if (runId == null) {
    // No caller identity wired in. This guard is a safety belt against
    // cross-run PR mutations, so it FAILS CLOSED: an unidentifiable caller
    // must not merge/approve. Production mounts always thread runId
    // (lib/profiles.ts); hitting this means a miswired mount, not a normal
    // call path.
    return {
      ok: false,
      result: errResult(
        `PR ownership guard: this tool was mounted without a caller run id, so ownership of ${prUrl} cannot be verified. Refusing to mutate the PR.`
      ),
    };
  }
  const verdict = await (await runTransport()).acquirePrLock(runId, prUrl);
  if (!verdict.ok) {
    return {
      ok: false,
      result: errResult(
        verdict.reason ?? `another run owns this PR (${prUrl}); refusing to mutate it.`
      ),
    };
  }
  return { ok: true };
}

type Gate = (url: string) => Promise<
  | { ok: true; parsed: ParsedPrUrl; matched: { id: string; name: string } }
  | { ok: false; result: ReturnType<typeof errResult> }
>;

function makeGate(): Gate {
  return async (url: string) => {
    // Repo-remote gating reads through the transport so HTTP workers never
    // touch the repositories table directly.
    const v = await validatePrUrl(url, async () => (await runTransport()).listRepoRemotes());
    if ("error" in v) return { ok: false, result: errResult(v.error) };
    return { ok: true, parsed: v.parsed, matched: v.matched };
  };
}

// Read-only tools: fetch PR metadata/diff. Safe for a reviewer driven by
// untrusted PR content — no mutation of GitHub state.
function registerReadTools(
  reg: BackendRegistrar,
  cwd: string | undefined,
  gate: Gate,
  opts: { repoFullName?: string | null } = {}
) {
  const fullName = opts.repoFullName ?? null;

  reg.registerTool({
    name: "gh_pr__pr_list",
    label: "PR List",
    description:
      "List pull requests for the current GitHub repository. Optionally filter by state.",
    parameters: Type.Object({
      state: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
        Type.Literal("merged"),
        Type.Literal("all"),
      ])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: async (_id, { state, limit }) => {
      if (!cwd && !fullName) {
        return errResult("PR listing needs either a local checkout or a registered GitHub remote.");
      }
      const fields =
        "number,title,state,url,author,headRefName,baseRefName,createdAt,updatedAt,isDraft";
      const args = [
        "pr",
        "list",
        ...repoFlag(fullName),
        "--state",
        state ?? "open",
        "--limit",
        String(Math.min(limit ?? 30, 100)),
        "--json",
        fields,
      ];
      const r = await gh(args, cwd);
      if (r.code !== 0) {
        return errResult(r.stderr.trim() || `gh pr list failed (exit ${r.code})`);
      }
      return ok(r.stdout);
    },
  });

  reg.registerTool({
    name: "gh_repo__branches",
    label: "GitHub Branches",
    description:
      "List branches from the registered GitHub repository, independent of local remote freshness.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      protected_only: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, { limit, protected_only }) => {
      if (!fullName) {
        return errResult("GitHub branch listing needs a registered GitHub remote.");
      }
      const args = [
        "api",
        "--method",
        "GET",
        `repos/${fullName}/branches`,
        "-F",
        `per_page=${Math.min(limit ?? 50, 100)}`,
      ];
      if (protected_only === true) args.push("-F", "protected=true");
      const r = await gh(args, cwd);
      if (r.code !== 0) {
        return errResult(r.stderr.trim() || `gh api branches failed (exit ${r.code})`);
      }
      return ok(r.stdout);
    },
  });

  reg.registerTool({
    name: "gh_pr__pr_view",
    label: "PR View",
    description:
      "Fetch a PR's metadata: state, mergeable, CI status, title, body, files. Pass the PR URL (https://github.com/<owner>/<repo>/pull/<n>) or short form (owner/repo#n).",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
    execute: async (_id, { url }) => {
      const g = await gate(url);
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
    },
  });

  reg.registerTool({
    name: "gh_pr__pr_diff",
    label: "PR Diff",
    description:
      "Fetch the diff for a PR. If `file` is provided, the diff is filtered to that path.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      file: Type.Optional(Type.String()),
    }),
    execute: async (_id, { url, file }) => {
      const g = await gate(url);
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
    },
  });

  reg.registerTool({
    name: "gh_pr__pr_comments",
    label: "PR Comments",
    description:
      "Read a PR's issue comments, review comments, and review summaries.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: async (_id, { url, limit }) => {
      const g = await gate(url);
      if (!g.ok) return g.result;
      const perPage = String(Math.min(limit ?? 50, 100));
      const issueComments = await gh([
        "api",
        "--method",
        "GET",
        `repos/${g.parsed.owner}/${g.parsed.repo}/issues/${g.parsed.number}/comments`,
        "-F",
        `per_page=${perPage}`,
      ], cwd);
      if (issueComments.code !== 0) {
        return errResult(issueComments.stderr.trim() || `gh api issue comments failed (exit ${issueComments.code})`);
      }
      const reviewComments = await gh([
        "api",
        "--method",
        "GET",
        `repos/${g.parsed.owner}/${g.parsed.repo}/pulls/${g.parsed.number}/comments`,
        "-F",
        `per_page=${perPage}`,
      ], cwd);
      if (reviewComments.code !== 0) {
        return errResult(reviewComments.stderr.trim() || `gh api review comments failed (exit ${reviewComments.code})`);
      }
      const reviews = await gh([
        "api",
        "--method",
        "GET",
        `repos/${g.parsed.owner}/${g.parsed.repo}/pulls/${g.parsed.number}/reviews`,
        "-F",
        `per_page=${perPage}`,
      ], cwd);
      if (reviews.code !== 0) {
        return errResult(reviews.stderr.trim() || `gh api reviews failed (exit ${reviews.code})`);
      }
      return ok(JSON.stringify({
        issue_comments: tryParseJson(issueComments.stdout),
        review_comments: tryParseJson(reviewComments.stdout),
        reviews: tryParseJson(reviews.stdout),
      }, null, 2));
    },
  });

  reg.registerTool({
    name: "gh_pr__pr_checks",
    label: "PR Checks",
    description:
      "Read current GitHub check/status details for a PR.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
    }),
    execute: async (_id, { url }) => {
      const g = await gate(url);
      if (!g.ok) return g.result;
      const fields = "name,state,startedAt,completedAt,link,description,bucket,workflow,event";
      const r = await gh(["pr", "checks", g.parsed.canonical, "--json", fields], cwd);
      if (r.code !== 0 && r.code !== 8) {
        return errResult(r.stderr.trim() || `gh pr checks failed (exit ${r.code})`);
      }
      return ok(r.stdout);
    },
  });
}

// gh_pr__pr_review: post a review verdict. `allowApprove` gates whether
// verdict='approve' is even an accepted parameter — the read-only variant
// omits it so a reviewer driven by untrusted PR content can leave
// comment/request_changes verdicts but can never approve its own review run.
function registerReviewTool(
  reg: BackendRegistrar,
  cwd: string | undefined,
  gate: Gate,
  opts: { allowApprove: boolean; runId?: number }
) {
  const verdicts = opts.allowApprove
    ? ([Type.Literal("approve"), Type.Literal("comment"), Type.Literal("request_changes")] as const)
    : ([Type.Literal("comment"), Type.Literal("request_changes")] as const);
  reg.registerTool({
    name: "gh_pr__pr_review",
    label: "PR Review",
    description: opts.allowApprove
      ? "Post a PR review. verdict='approve' approves, 'comment' leaves a top-level review comment, 'request_changes' requests changes. body is required for comment/request_changes; optional for approve."
      : "Post a PR review. verdict='comment' leaves a top-level review comment, 'request_changes' requests changes. body is required for both. This read-only variant cannot approve — approval is done outside the reviewer run.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      verdict: Type.Union(verdicts as unknown as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
      body: Type.Optional(Type.String()),
    }),
    execute: async (_id, { url, verdict, body }) => {
      const g = await gate(url);
      if (!g.ok) return g.result;
      // Defense in depth: even if a caller smuggles 'approve' past the schema,
      // the read-only variant refuses to shell out an --approve.
      if (verdict === "approve" && !opts.allowApprove) {
        return errResult("verdict='approve' is not permitted from this tool set.");
      }
      if (verdict === "approve") {
        const lock = await checkAndAcquirePrLock(g.parsed.canonical, opts.runId);
        if (!lock.ok) return lock.result;
      }
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
    },
  });
}

// gh_pr__pr_comment: plain PR comments (top-level or inline). Never approves
// or merges, so it's shared unchanged by both the full and read-only tool sets.
function registerCommentTool(reg: BackendRegistrar, cwd: string | undefined, gate: Gate) {
  reg.registerTool({
    name: "gh_pr__pr_comment",
    label: "PR Comment",
    description:
      "Post a comment on a PR. If `line` and `file` are both provided, posts an inline review comment on that line; otherwise posts a top-level PR comment.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      body: Type.String({ minLength: 1 }),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      file: Type.Optional(Type.String()),
    }),
    execute: async (_id, { url, body, line, file }) => {
      const g = await gate(url);
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
    },
  });
}

// gh_pr__pr_merge: mutating, never part of the read-only tool set.
function registerMergeTool(
  reg: BackendRegistrar,
  cwd: string | undefined,
  gate: Gate,
  runId: number | undefined
) {
  reg.registerTool({
    name: "gh_pr__pr_merge",
    label: "PR Merge",
    description:
      "Merge a PR. method='merge' creates a merge commit, 'squash' squashes commits, 'rebase' rebases. Set delete_branch=true to also delete the PR's head branch after merging. Set auto=true to arm GitHub auto-merge instead of merging immediately.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      method: Type.Union([
        Type.Literal("merge"),
        Type.Literal("squash"),
        Type.Literal("rebase"),
      ]),
      delete_branch: Type.Optional(Type.Boolean()),
      auto: Type.Optional(
        Type.Boolean({
          description:
            "Enable GitHub auto-merge (merge automatically once required checks pass) instead of merging now. Requires auto-merge enabled + branch protection on the repo.",
        })
      ),
    }),
    execute: async (_id, { url, method, delete_branch, auto }) => {
      const g = await gate(url);
      if (!g.ok) return g.result;
      const lock = await checkAndAcquirePrLock(g.parsed.canonical, runId);
      if (!lock.ok) return lock.result;
      const args = ["pr", "merge", g.parsed.canonical];
      if (auto) args.push("--auto");
      if (method === "merge") args.push("--merge");
      else if (method === "squash") args.push("--squash");
      else args.push("--rebase");
      if (delete_branch) args.push("--delete-branch");
      const r = await gh(args, cwd);
      if (r.code !== 0) {
        return errResult(r.stderr.trim() || `gh pr merge failed (exit ${r.code})`);
      }
      return ok(
        JSON.stringify(
          {
            ok: true,
            method,
            delete_branch: delete_branch === true,
            auto: auto === true,
            pr: g.parsed.canonical,
            stdout: r.stdout.trim(),
          },
          null,
          2
        )
      );
    },
  });
}

// Full tool set: view, diff, review (approve allowed), comment, merge. Used
// by implementor/executor runs that legitimately manage their own PR.
export const ghPrExtension =
  (opts: GhPrExtensionOptions = {}): ExtensionFactory =>
  (reg) => {
    const cwd = opts.cwd;
    const fullName = repoFullName(opts.remote);
    const gate = makeGate();
    registerReadTools(reg, cwd, gate, { repoFullName: fullName });
    registerReviewTool(reg, cwd, gate, { allowApprove: true, runId: opts.runId });
    registerCommentTool(reg, cwd, gate);
    registerMergeTool(reg, cwd, gate, opts.runId);
  };

// Read-only tool set: view, diff, review (no 'approve'), comment. No
// pr_merge. Mounted for review runs, which check out an untrusted
// third-party PR — a prompt-injected instruction in the PR body/diff must
// not be able to merge or approve the very PR it's reviewing.
export const ghPrReadOnlyExtension =
  (opts: GhPrExtensionOptions = {}): ExtensionFactory =>
  (reg) => {
    const cwd = opts.cwd;
    const fullName = repoFullName(opts.remote);
    const gate = makeGate();
    registerReadTools(reg, cwd, gate, { repoFullName: fullName });
    registerReviewTool(reg, cwd, gate, { allowApprove: false, runId: opts.runId });
    registerCommentTool(reg, cwd, gate);
  };

// Strict read-only set for lightweight chat: list/view/diff only. Unlike
// ghPrReadOnlyExtension this cannot write PR comments or review verdicts.
export const ghPrStrictReadOnlyExtension =
  (opts: GhPrExtensionOptions = {}): ExtensionFactory =>
  (reg) => {
    const cwd = opts.cwd;
    const fullName = repoFullName(opts.remote);
    const gate = makeGate();
    registerReadTools(reg, cwd, gate, { repoFullName: fullName });
  };

// ──────────────────────────────────────────────────────────
// Helpers (verbatim from lib/gh-pr-mcp.ts)
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
