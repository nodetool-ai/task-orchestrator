// lib/extensions/gh-pr.ts
//
// gh_pr extension: pi-side replacement for lib/gh-pr-mcp.ts. Tools are
// flat-namespaced as gh_pr__<name>. GitHub I/O runs in-process through the
// orchestrator's memoized Octokit client (lib/github-client.ts) — it used to
// shell out to the `gh` CLI; the tool contracts (names, schemas, and the
// shape/wording of the returned text) are preserved.

import { Type } from "typebox";
import {
  ownerRepoFromRemote,
  parsePrUrl,
  validatePrUrl,
  type ParsedPrUrl,
  type UrlValidation,
} from "../gh-url";
import { runTransport } from "@/lib/worker";
import {
  getOctokit,
  describeGithubError,
  fetchChecksRollupForRef,
} from "../github-client";
import type { BackendRegistrar, ExtensionFactory } from "./types";

// Re-export so consumers importing 'lib/extensions/gh-pr' get the URL helpers too.
export { ownerRepoFromRemote, parsePrUrl, validatePrUrl };
export type { ParsedPrUrl, UrlValidation };

const ok = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

export interface GhPrExtensionOptions {
  cwd?: string;
  /** Registered repository remote. Lets lightweight chat use GitHub tools even
   *  when there is no local checkout to run against. */
  remote?: string | null;
  /** Caller's run id, used by the resource-lock guard (docs/agent-events.md
   *  §5.2) on mutating tools (merge, approve). Required for ghPrExtension;
   *  unused by ghPrReadOnlyExtension (no merge tool, approve excluded). */
  runId?: number;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

function ownerRepoFromFullName(remote: string | null | undefined): OwnerRepo | null {
  if (!remote) return null;
  const parsed = ownerRepoFromRemote(remote);
  return parsed ? { owner: parsed.owner, repo: parsed.repo } : null;
}

function repoFullName(remote: string | null | undefined): string | null {
  const or = ownerRepoFromFullName(remote);
  return or ? `${or.owner}/${or.repo}` : null;
}

/**
 * Resource-lock guard (§5.2): a `pr:<url>` lease answers "who owns this PR"
 * with a single primary-key lookup instead of a subtree walk per mutating
 * call. Locked by a live run that isn't the caller -> refuse, naming the
 * owner. Unlocked, or locked by a run that has since gone terminal -> proceed
 * and take/refresh the lease for the caller. One shared helper so both
 * pr_merge and the approving pr_review branch enforce the exact same rule.
 * The lease itself lives on the orchestrator (transport.acquirePrLock —
 * workers hold no database access); only the GitHub I/O runs in-process.
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

// ──────────────────────────────────────────────────────────
// REST → gh-shaped field mapping helpers
// ──────────────────────────────────────────────────────────

type RestPull = Record<string, unknown>;

/** gh reports PR state uppercase, and surfaces MERGED separately from CLOSED. */
function ghState(pr: RestPull): string {
  if (pr.merged_at) return "MERGED";
  return String(pr.state ?? "").toUpperCase();
}

/** gh's mergeable enum: MERGEABLE / CONFLICTING / UNKNOWN. REST gives a tri-state bool. */
function ghMergeable(pr: RestPull): string {
  const m = pr.mergeable;
  if (m === true) return "MERGEABLE";
  if (m === false) return "CONFLICTING";
  return "UNKNOWN";
}

function ghAuthor(pr: RestPull): { login: string | null } | null {
  const user = pr.user as { login?: string } | null | undefined;
  return user ? { login: user.login ?? null } : null;
}

// ──────────────────────────────────────────────────────────
// Read-only tools: fetch PR metadata/diff. Safe for a reviewer driven by
// untrusted PR content — no mutation of GitHub state.
// ──────────────────────────────────────────────────────────
function registerReadTools(
  reg: BackendRegistrar,
  cwd: string | undefined,
  gate: Gate,
  opts: { repoFullName?: string | null } = {}
) {
  const fullName = opts.repoFullName ?? null;
  const baseRepo = ownerRepoFromFullName(fullName);

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
      if (!cwd && !baseRepo) {
        return errResult("PR listing needs either a local checkout or a registered GitHub remote.");
      }
      if (!baseRepo) {
        return errResult("PR listing needs a registered GitHub remote.");
      }
      const want = state ?? "open";
      // REST list has no "merged" state — merged PRs live under "closed" with a
      // non-null merged_at. Fetch closed and filter when the caller wants merged.
      const restState = want === "merged" ? "closed" : want;
      const perPage = Math.min(limit ?? 30, 100);
      try {
        const { data } = await getOctokit().pulls.list({
          owner: baseRepo.owner,
          repo: baseRepo.repo,
          state: restState as "open" | "closed" | "all",
          per_page: perPage,
          sort: "created",
          direction: "desc",
        });
        let pulls = data as RestPull[];
        if (want === "merged") pulls = pulls.filter((p) => p.merged_at != null);
        const out = pulls.slice(0, perPage).map((p) => ({
          number: p.number ?? null,
          title: p.title ?? null,
          state: ghState(p),
          url: p.html_url ?? null,
          author: ghAuthor(p),
          headRefName: (p.head as RestPull | null)?.ref ?? null,
          baseRefName: (p.base as RestPull | null)?.ref ?? null,
          createdAt: p.created_at ?? null,
          updatedAt: p.updated_at ?? null,
          isDraft: p.draft ?? false,
        }));
        return ok(JSON.stringify(out));
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr list failed");
      }
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
      if (!baseRepo) {
        return errResult("GitHub branch listing needs a registered GitHub remote.");
      }
      try {
        const { data } = await getOctokit().repos.listBranches({
          owner: baseRepo.owner,
          repo: baseRepo.repo,
          per_page: Math.min(limit ?? 50, 100),
          ...(protected_only === true ? { protected: true } : {}),
        });
        return ok(JSON.stringify(data));
      } catch (err) {
        return errResult(describeGithubError(err) || "gh api branches failed");
      }
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
      const { owner, repo, number } = g.parsed;
      try {
        const octokit = getOctokit();
        const { data: pr } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: number,
        });
        const headSha = (pr.head as RestPull | null)?.sha as string | undefined;
        const [files, checks] = await Promise.all([
          octokit.paginate(octokit.pulls.listFiles, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }),
          headSha
            ? fetchChecksRollupForRef(owner, repo, headSha)
            : Promise.resolve([]),
        ]);
        const ciStatus = summarizeChecks(checks as unknown as Array<Record<string, unknown>>);
        const payload = {
          url: pr.html_url ?? g.parsed.canonical,
          number: pr.number ?? g.parsed.number,
          state: ghState(pr as RestPull),
          mergeable: ghMergeable(pr as RestPull),
          merge_state_status:
            typeof pr.mergeable_state === "string"
              ? pr.mergeable_state.toUpperCase()
              : null,
          ci_status: ciStatus,
          title: pr.title ?? null,
          body: pr.body ?? null,
          head_ref: (pr.head as RestPull | null)?.ref ?? null,
          base_ref: (pr.base as RestPull | null)?.ref ?? null,
          author: ghAuthor(pr as RestPull),
          is_draft: pr.draft ?? null,
          additions: pr.additions ?? null,
          deletions: pr.deletions ?? null,
          changed_files: pr.changed_files ?? null,
          files: (files as Array<Record<string, unknown>>).map((f) => ({
            path: f.filename ?? null,
            additions: f.additions ?? null,
            deletions: f.deletions ?? null,
          })),
          repo: g.matched,
        };
        return ok(JSON.stringify(payload, null, 2));
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr view failed");
      }
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
      const { owner, repo, number } = g.parsed;
      let diff: string;
      try {
        // REST returns the unified diff verbatim when asked for the `diff`
        // media type (the response body is a string, not JSON).
        const res = await getOctokit().pulls.get({
          owner,
          repo,
          pull_number: number,
          mediaType: { format: "diff" },
        });
        diff = res.data as unknown as string;
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr diff failed");
      }
      if (!file) return ok(diff);
      const filtered = filterDiffByFile(diff, file);
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
      const { owner, repo, number } = g.parsed;
      const perPage = Math.min(limit ?? 50, 100);
      try {
        const octokit = getOctokit();
        const [issueComments, reviewComments, reviews] = await Promise.all([
          octokit.issues.listComments({ owner, repo, issue_number: number, per_page: perPage }),
          octokit.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: perPage }),
          octokit.pulls.listReviews({ owner, repo, pull_number: number, per_page: perPage }),
        ]);
        return ok(JSON.stringify({
          issue_comments: issueComments.data,
          review_comments: reviewComments.data,
          reviews: reviews.data,
        }, null, 2));
      } catch (err) {
        return errResult(describeGithubError(err) || "gh api comments failed");
      }
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
      const { owner, repo, number } = g.parsed;
      try {
        const octokit = getOctokit();
        const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
        const headSha = (pr.head as RestPull | null)?.sha as string | undefined;
        const rollup = headSha ? await fetchChecksRollupForRef(owner, repo, headSha) : [];
        // Shape each entry to the `gh pr checks --json` field names.
        const out = rollup.map((c) => {
          const stateRaw = c.conclusion ?? c.status ?? c.state ?? null;
          return {
            name: c.name,
            state: stateRaw ? String(stateRaw).toUpperCase() : null,
            startedAt: c.startedAt,
            completedAt: c.completedAt,
            link: c.link,
            description: c.description,
            bucket: bucketForCheck(c),
            workflow: c.workflow,
            event: c.event,
          };
        });
        return ok(JSON.stringify(out));
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr checks failed");
      }
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
      // the read-only variant refuses to submit an approving review.
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
      const event =
        verdict === "approve"
          ? "APPROVE"
          : verdict === "comment"
            ? "COMMENT"
            : "REQUEST_CHANGES";
      const { owner, repo, number } = g.parsed;
      try {
        await getOctokit().pulls.createReview({
          owner,
          repo,
          pull_number: number,
          event: event as "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
          ...(body && body.length > 0 ? { body } : {}),
        });
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr review failed");
      }
      return ok(
        JSON.stringify(
          {
            ok: true,
            verdict,
            pr: g.parsed.canonical,
            stdout: `Review (${verdict}) posted on ${g.parsed.canonical}`,
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
      const { owner, repo, number } = g.parsed;
      const inline = line !== undefined && file !== undefined && file.length > 0;
      if ((line !== undefined) !== (file !== undefined && file.length > 0)) {
        return errResult(
          "Inline comments require both `line` and `file`. To leave a top-level comment, omit both."
        );
      }
      if (inline) {
        const octokit = getOctokit();
        // Inline review comments must be anchored to the PR's head commit.
        let commitId: string | null = null;
        try {
          const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
          commitId = ((pr.head as RestPull | null)?.sha as string) ?? null;
        } catch (err) {
          return errResult(describeGithubError(err) || "gh pr view (for headRefOid) failed");
        }
        if (!commitId) {
          return errResult(`PR ${g.parsed.canonical} has no headRefOid; can't inline-comment.`);
        }
        try {
          const { data } = await octokit.pulls.createReviewComment({
            owner,
            repo,
            pull_number: number,
            body,
            commit_id: commitId,
            path: file!,
            line: line!,
            side: "RIGHT",
          });
          return ok(
            JSON.stringify(
              { ok: true, kind: "inline", pr: g.parsed.canonical, file, line, response: data },
              null,
              2
            )
          );
        } catch (err) {
          return errResult(describeGithubError(err) || "gh api (inline comment) failed");
        }
      }
      // Top-level PR comment
      try {
        await getOctokit().issues.createComment({
          owner,
          repo,
          issue_number: number,
          body,
        });
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr comment failed");
      }
      return ok(
        JSON.stringify(
          { ok: true, kind: "top_level", pr: g.parsed.canonical, stdout: `Comment posted on ${g.parsed.canonical}` },
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
      const { owner, repo, number } = g.parsed;
      try {
        if (auto) {
          // Auto-merge is a GraphQL-only mutation (enablePullRequestAutoMerge);
          // there is no REST equivalent.
          await enableAutoMerge(owner, repo, number, method);
        } else {
          await getOctokit().pulls.merge({
            owner,
            repo,
            pull_number: number,
            merge_method: method,
          });
          if (delete_branch) {
            const { data: pr } = await getOctokit().pulls.get({
              owner,
              repo,
              pull_number: number,
            });
            const headRef = (pr.head as RestPull | null)?.ref as string | undefined;
            if (headRef) {
              await getOctokit()
                .git.deleteRef({ owner, repo, ref: `heads/${headRef}` })
                .catch(() => {
                  /* best-effort branch delete, mirrors gh --delete-branch */
                });
            }
          }
        }
      } catch (err) {
        return errResult(describeGithubError(err) || "gh pr merge failed");
      }
      return ok(
        JSON.stringify(
          {
            ok: true,
            method,
            delete_branch: delete_branch === true,
            auto: auto === true,
            pr: g.parsed.canonical,
            stdout: auto
              ? `Auto-merge armed for ${g.parsed.canonical}`
              : `Merged ${g.parsed.canonical}`,
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
// Helpers
// ──────────────────────────────────────────────────────────

/**
 * Arm GitHub auto-merge on a PR via the GraphQL `enablePullRequestAutoMerge`
 * mutation. Requires the PR's GraphQL node id (fetched via pulls.get). The
 * merge method enum maps 1:1 to gh's --merge/--squash/--rebase.
 */
async function enableAutoMerge(
  owner: string,
  repo: string,
  number: number,
  method: "merge" | "squash" | "rebase"
): Promise<void> {
  const octokit = getOctokit();
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
  const nodeId = pr.node_id;
  const mergeMethod = method.toUpperCase(); // MERGE | SQUASH | REBASE
  await octokit.graphql(
    `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
        clientMutationId
      }
    }`,
    { pullRequestId: nodeId, mergeMethod }
  );
}

// Map a rollup check entry to gh's `bucket` field (pass/fail/pending/skipping/cancel).
function bucketForCheck(c: {
  status: string | null;
  conclusion: string | null;
  state: string | null;
}): string {
  const status = c.status?.toUpperCase();
  if (status && status !== "COMPLETED") return "pending";
  const verdict = (c.conclusion ?? c.state ?? "").toUpperCase();
  switch (verdict) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "CANCELLED":
    case "CANCELED":
      return "cancel";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "PENDING":
    case "IN_PROGRESS":
    case "QUEUED":
      return "pending";
    default:
      return "skipping";
  }
}

// Collapse the check rollup into a single SUCCESS / FAILURE / PENDING /
// NEUTRAL summary, with a count breakdown. Empty rollup → "NONE".
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
