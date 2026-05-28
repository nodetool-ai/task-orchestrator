// GitHub webhook: signature verification + payload normalization + run
// matching.
//
// This module is intentionally side-effect free (only node:crypto) so it can
// be unit-tested without touching the DB or the agent SDK. The side-effecting
// dispatch — persisting events, transitioning tasks, resuming agents — lives
// in lib/github-webhook-handler.ts.

import { createHmac, timingSafeEqual } from "node:crypto";

// ──────────────────────────────────────────────────────────
// Signature verification
// ──────────────────────────────────────────────────────────

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` header against the raw
 * request body using the shared secret. GitHub computes
 * `sha256=<hex(hmac_sha256(secret, body))>`. Comparison is constant-time.
 *
 * Returns false (never throws) for any malformed / missing input.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws if lengths differ; guard first (the length itself
  // isn't secret — it's fixed for sha256 — so an early return is fine).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ──────────────────────────────────────────────────────────
// Normalized event shape
// ──────────────────────────────────────────────────────────

export type WebhookKind = "pr" | "review" | "comment" | "ci";
export type CiState = "success" | "failure" | "pending" | "neutral";

export interface NormalizedWebhookEvent {
  /** Coarse bucket used by the dispatcher to pick side effects. */
  kind: WebhookKind;
  /** Raw `X-GitHub-Event` value (pull_request, check_suite, …). */
  event: string;
  /** Payload `action`, when present (closed, completed, submitted, …). */
  action: string | null;
  /** "owner/repo" exactly as GitHub reported it (compare case-insensitively). */
  repoFullName: string | null;
  /** Canonical https PR urls this event relates to (may be empty). */
  prUrls: string[];
  /** Head branch / ref, when known. Used to match runs lacking a PR url. */
  branch: string | null;
  headSha: string | null;
  /** Rolled-up CI verdict for `kind === "ci"`, else null. */
  ciState: CiState | null;
  /** Raw conclusion/state string (failure, timed_out, success, …). */
  conclusion: string | null;
  /** True for a merged pull_request close event. */
  merged: boolean;
  prState: string | null;
  workflowName: string | null;
  /** Login of the actor (sender / review author / commenter). */
  actor: string | null;
  /** Free-text body for reviews / comments. */
  body: string | null;
  /** html_url of the underlying object (review, comment, run), if any. */
  url: string | null;
  /** One-line human summary, suitable for a task note. */
  summary: string;
}

// ──────────────────────────────────────────────────────────
// PR url canonicalization (self-contained; no repo lookup)
// ──────────────────────────────────────────────────────────

const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/pull\/(\d+)/i;

/** Canonicalize any PR url/short form to a lowercased comparison key, or null. */
export function canonicalizePrUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).match(PR_URL_RE);
  if (!m) return null;
  const n = parseInt(m[3], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull/${n}`.toLowerCase();
}

function prUrlFrom(fullName: string | null, number: number | null | undefined): string | null {
  if (!fullName || number == null) return null;
  return canonicalizePrUrl(`https://github.com/${fullName}/pull/${number}`);
}

// ──────────────────────────────────────────────────────────
// Payload parsing
// ──────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Map a GitHub check/run conclusion (or commit-status state) to a CiState. */
function ciStateFrom(status: string | null, conclusion: string | null): CiState {
  // Workflow/check still in flight.
  if (status && status.toLowerCase() !== "completed") return "pending";
  const verdict = (conclusion ?? "").toLowerCase();
  switch (verdict) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "canceled":
    case "action_required":
    case "startup_failure":
    case "stale":
    case "error":
      return "failure";
    case "neutral":
    case "skipped":
      return "neutral";
    case "pending":
    case "queued":
    case "in_progress":
    case "requested":
    case "waiting":
      return "pending";
    default:
      return "neutral";
  }
}

function pullUrlsFrom(repoFullName: string | null, pulls: unknown): string[] {
  if (!Array.isArray(pulls)) return [];
  const out: string[] = [];
  for (const p of pulls) {
    const po = asObj(p);
    if (!po) continue;
    const html = canonicalizePrUrl(str(po.html_url));
    const built = prUrlFrom(repoFullName, typeof po.number === "number" ? po.number : null);
    const u = html ?? built;
    if (u) out.push(u);
  }
  return out;
}

/**
 * Normalize a raw GitHub webhook payload into a {@link NormalizedWebhookEvent},
 * or return null for events we don't act on (so the route can 202-ignore them).
 *
 * Handled events: pull_request, pull_request_review, issue_comment (PRs only),
 * check_run, check_suite, workflow_run, status.
 */
export function parseWebhookEvent(
  eventName: string,
  payload: unknown
): NormalizedWebhookEvent | null {
  const root = asObj(payload);
  if (!root) return null;
  const repoFullName = str(asObj(root.repository)?.full_name);
  const action = str(root.action);
  const sender = str(asObj(root.sender)?.login);

  switch (eventName) {
    case "pull_request": {
      const pr = asObj(root.pull_request);
      if (!pr) return null;
      const head = asObj(pr.head);
      const url = canonicalizePrUrl(str(pr.html_url));
      const merged = pr.merged === true;
      const prState = str(pr.state);
      const action0 = action ?? "";
      const verb = merged
        ? "merged"
        : action0 === "closed"
          ? "closed"
          : action0 === "synchronize"
            ? "updated"
            : action0 || "changed";
      return {
        kind: "pr",
        event: eventName,
        action,
        repoFullName,
        prUrls: url ? [url] : [],
        branch: str(head?.ref),
        headSha: str(head?.sha),
        ciState: null,
        conclusion: null,
        merged,
        prState,
        workflowName: null,
        actor: sender,
        body: null,
        url: str(pr.html_url),
        summary: `PR ${verb}${url ? ` (${url})` : ""}`,
      };
    }

    case "pull_request_review": {
      const review = asObj(root.review);
      const pr = asObj(root.pull_request);
      if (!review || !pr) return null;
      const head = asObj(pr.head);
      const url = canonicalizePrUrl(str(pr.html_url));
      const state = (str(review.state) ?? "").toLowerCase();
      const author = str(asObj(review.user)?.login) ?? sender;
      return {
        kind: "review",
        event: eventName,
        action,
        repoFullName,
        prUrls: url ? [url] : [],
        branch: str(head?.ref),
        headSha: str(head?.sha),
        ciState: null,
        conclusion: state || null,
        merged: false,
        prState: null,
        workflowName: null,
        actor: author,
        body: str(review.body),
        url: str(review.html_url),
        summary: `Review ${state || "submitted"}${author ? ` by ${author}` : ""}`,
      };
    }

    case "issue_comment": {
      const issue = asObj(root.issue);
      const comment = asObj(root.comment);
      if (!issue || !comment) return null;
      // Only PR comments matter here; issue.pull_request is present iff the
      // issue is actually a PR.
      if (!asObj(issue.pull_request)) return null;
      const number = typeof issue.number === "number" ? issue.number : null;
      const url = prUrlFrom(repoFullName, number);
      const author = str(asObj(comment.user)?.login) ?? sender;
      return {
        kind: "comment",
        event: eventName,
        action,
        repoFullName,
        prUrls: url ? [url] : [],
        branch: null,
        headSha: null,
        ciState: null,
        conclusion: null,
        merged: false,
        prState: null,
        workflowName: null,
        actor: author,
        body: str(comment.body),
        url: str(comment.html_url),
        summary: `PR comment${author ? ` by ${author}` : ""}`,
      };
    }

    case "check_run": {
      const cr = asObj(root.check_run);
      if (!cr) return null;
      const suite = asObj(cr.check_suite);
      const status = str(cr.status);
      const conclusion = str(cr.conclusion);
      const ciState = ciStateFrom(status, conclusion);
      const name = str(cr.name);
      return {
        kind: "ci",
        event: eventName,
        action,
        repoFullName,
        prUrls: pullUrlsFrom(repoFullName, cr.pull_requests),
        branch: str(suite?.head_branch),
        headSha: str(cr.head_sha),
        ciState,
        conclusion: conclusion ?? status,
        merged: false,
        prState: null,
        workflowName: name,
        actor: sender,
        body: null,
        url: str(cr.html_url),
        summary: `Check "${name ?? "run"}" ${conclusion ?? status ?? "updated"}`,
      };
    }

    case "check_suite": {
      const cs = asObj(root.check_suite);
      if (!cs) return null;
      const status = str(cs.status);
      const conclusion = str(cs.conclusion);
      const ciState = ciStateFrom(status, conclusion);
      const appName = str(asObj(cs.app)?.name);
      return {
        kind: "ci",
        event: eventName,
        action,
        repoFullName,
        prUrls: pullUrlsFrom(repoFullName, cs.pull_requests),
        branch: str(cs.head_branch),
        headSha: str(cs.head_sha),
        ciState,
        conclusion: conclusion ?? status,
        merged: false,
        prState: null,
        workflowName: appName,
        actor: sender,
        body: null,
        url: null,
        summary: `Check suite ${conclusion ?? status ?? "updated"}`,
      };
    }

    case "workflow_run": {
      const wr = asObj(root.workflow_run);
      if (!wr) return null;
      const status = str(wr.status);
      const conclusion = str(wr.conclusion);
      const ciState = ciStateFrom(status, conclusion);
      const name = str(wr.name);
      return {
        kind: "ci",
        event: eventName,
        action,
        repoFullName,
        prUrls: pullUrlsFrom(repoFullName, wr.pull_requests),
        branch: str(wr.head_branch),
        headSha: str(wr.head_sha),
        ciState,
        conclusion: conclusion ?? status,
        merged: false,
        prState: null,
        workflowName: name,
        actor: sender,
        body: null,
        url: str(wr.html_url),
        summary: `Workflow "${name ?? "run"}" ${conclusion ?? status ?? "updated"}`,
      };
    }

    case "status": {
      // Commit status (legacy). No PR linkage — matched by branch.
      const state = (str(root.state) ?? "").toLowerCase();
      const ciState =
        state === "success"
          ? "success"
          : state === "failure" || state === "error"
            ? "failure"
            : "pending";
      const branches = Array.isArray(root.branches) ? root.branches : [];
      const firstBranch = str(asObj(branches[0])?.name);
      const context = str(root.context);
      return {
        kind: "ci",
        event: eventName,
        action: null,
        repoFullName,
        prUrls: [],
        branch: firstBranch,
        headSha: str(root.sha),
        ciState,
        conclusion: state || null,
        merged: false,
        prState: null,
        workflowName: context,
        actor: sender,
        body: null,
        url: str(root.target_url),
        summary: `Status "${context ?? "check"}" ${state || "updated"}`,
      };
    }

    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────
// Run matching
// ──────────────────────────────────────────────────────────

export interface CandidateRun {
  id: number;
  prUrl: string | null;
  branch: string | null;
  repoId: string | null;
}

/**
 * Select which runs an event applies to. A run matches if either:
 *   • its recorded PR url canonicalizes to one of the event's PR urls, or
 *   • its branch equals the event's head branch AND the run's repository
 *     resolves to the event's repo (guards against branch-name collisions
 *     across repositories).
 *
 * `repoOwnerRepoById` maps repoId → "owner/repo" (any case); entries that
 * can't be resolved (no github remote) simply won't match by branch.
 */
export function selectMatchingRunIds(
  event: NormalizedWebhookEvent,
  candidates: CandidateRun[],
  repoOwnerRepoById: Map<string, string>
): number[] {
  const prKeys = new Set(
    event.prUrls.map((u) => canonicalizePrUrl(u)).filter((u): u is string => !!u)
  );
  const wantRepo = event.repoFullName?.toLowerCase() ?? null;
  const branch = event.branch;
  const matched = new Set<number>();

  for (const c of candidates) {
    const canon = canonicalizePrUrl(c.prUrl);
    if (canon && prKeys.has(canon)) {
      matched.add(c.id);
      continue;
    }
    if (branch && c.branch && c.branch === branch && wantRepo && c.repoId) {
      const owner = repoOwnerRepoById.get(c.repoId)?.toLowerCase() ?? null;
      if (owner && owner === wantRepo) matched.add(c.id);
    }
  }
  return [...matched];
}
