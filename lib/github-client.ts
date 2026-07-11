// lib/github-client.ts
//
// Single thin GitHub REST client for the ORCHESTRATOR's own GitHub I/O.
// Replaces the `spawn("gh", …)` subprocess shell-outs that used to back the
// gh_pr__* / gh_ci__* agent tools, the PR→task sync poller, and the
// mergeability probe. Agent-facing `gh` usage inside worker containers is
// unaffected — this module is for in-process server-side calls only.
//
// Auth comes from GH_TOKEN (falling back to GITHUB_TOKEN), the same env the
// old `gh` subprocess picked up automatically. The instance is memoized so
// the retry/throttle state is shared across all callers.

import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

// Mirror the old 120s subprocess timeout (GH_TIMEOUT_SECONDS) so a hung
// request can't wedge a tool call or the poller indefinitely.
export const GH_REQUEST_TIMEOUT_MS = 120_000;

const OrchestratorOctokit = Octokit.plugin(retry, throttling);

export type GithubClient = InstanceType<typeof OrchestratorOctokit>;

let cached: GithubClient | null = null;

/** Resolve the token the client authenticates with: GH_TOKEN, then GITHUB_TOKEN. */
export function githubToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

/**
 * A fetch wrapper that enforces a per-request timeout via AbortController.
 * @octokit/request v10 dropped the node-fetch `request.timeout` option, so we
 * layer the timeout on top of the runtime fetch instead.
 */
function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_REQUEST_TIMEOUT_MS);
  // If the caller already passed a signal (Octokit does for its own retries),
  // honour it too by aborting our controller when theirs fires.
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

/** Memoized Octokit instance authenticated from the process env. */
export function getOctokit(): GithubClient {
  if (cached) return cached;
  cached = new OrchestratorOctokit({
    auth: githubToken(),
    request: { fetch: timeoutFetch },
    throttle: {
      // Retry once on a primary rate-limit hit; give up afterwards so a
      // wedged call still surfaces an error rather than looping forever.
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 1,
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 1,
    },
  });
  return cached;
}

/** Test seam: drop the memoized client so a later getOctokit() re-reads env. */
export function resetOctokit(): void {
  cached = null;
}

/**
 * A single entry of the combined "status check rollup" — the union of a
 * commit's Checks API check-runs and its legacy commit-statuses, shaped so the
 * existing `summarizeChecks` / `rollupToCiConclusion` collapsers (which read
 * `status`/`conclusion`/`state`) keep working unchanged. Extra display fields
 * (name/link/…) are carried alongside for the tools that surface them.
 */
export interface RollupCheckEntry {
  name: string | null;
  status: string | null; // check-run status (queued|in_progress|completed)
  conclusion: string | null; // check-run conclusion (success|failure|…)
  state: string | null; // legacy commit-status state (success|failure|pending|…)
  startedAt: string | null;
  completedAt: string | null;
  link: string | null;
  description: string | null;
  workflow: string | null;
  event: string | null;
}

/**
 * Fetch the combined check-runs + commit-statuses for a git ref, mirroring
 * what `gh pr view --json statusCheckRollup` / `gh pr checks` used to return.
 * Check-runs come from the Checks API; legacy statuses from the combined-status
 * endpoint (already deduped to the latest per context).
 */
/**
 * Fetch ALL legacy commit-status contexts for a ref across pages. The combined
 * status endpoint paginates the nested `statuses` array (30/page default), so a
 * single request silently drops contexts past the first page.
 */
async function fetchAllCombinedStatuses(
  octokit: GithubClient,
  owner: string,
  repo: string,
  ref: string
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    const statuses = (data.statuses ?? []) as Array<Record<string, unknown>>;
    all.push(...statuses);
    // Stop once a short page arrives or we've collected the reported total.
    if (statuses.length < 100 || all.length >= (data.total_count ?? all.length)) break;
  }
  return all;
}

export async function fetchChecksRollupForRef(
  owner: string,
  repo: string,
  ref: string
): Promise<RollupCheckEntry[]> {
  const octokit = getOctokit();
  const [checkRuns, combined] = await Promise.all([
    octokit.paginate(octokit.checks.listForRef, {
      owner,
      repo,
      ref,
      per_page: 100,
    }),
    // The combined-status endpoint returns only 30 contexts per page by default,
    // so a ref with >30 legacy statuses would drop any FAILING context past
    // page 1 and be misreported as green. Paginate explicitly by page (its
    // response carries a top-level `url`, which defeats octokit.paginate's
    // list-normalization, so we can't rely on that helper here) and aggregate
    // every page's `statuses`.
    fetchAllCombinedStatuses(octokit, owner, repo, ref).catch(
      () => [] as Array<Record<string, unknown>>
    ),
  ]);

  const out: RollupCheckEntry[] = [];
  for (const c of checkRuns as Array<Record<string, unknown>>) {
    const app = c.app as { name?: string } | null | undefined;
    out.push({
      name: (c.name as string) ?? null,
      status: (c.status as string) ?? null,
      conclusion: (c.conclusion as string) ?? null,
      state: null,
      startedAt: (c.started_at as string) ?? null,
      completedAt: (c.completed_at as string) ?? null,
      link: (c.html_url as string) ?? (c.details_url as string) ?? null,
      description: (c.output as { title?: string } | null)?.title ?? null,
      workflow: app?.name ?? null,
      event: null,
    });
  }
  for (const s of combined as Array<Record<string, unknown>>) {
    out.push({
      name: (s.context as string) ?? null,
      status: null,
      conclusion: null,
      state: (s.state as string) ?? null,
      startedAt: (s.created_at as string) ?? null,
      completedAt: (s.updated_at as string) ?? null,
      link: (s.target_url as string) ?? null,
      description: (s.description as string) ?? null,
      workflow: null,
      event: null,
    });
  }
  return out;
}

/**
 * Turn an Octokit/REST error into readable one-line text, so tool results keep
 * returning human-readable error strings (as the old `gh` stderr did) instead
 * of throwing a raw error object at the agent.
 */
export function describeGithubError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      status?: number;
      message?: string;
      name?: string;
      response?: { data?: { message?: string; errors?: unknown } };
    };
    const parts: string[] = [];
    if (typeof e.status === "number") parts.push(`HTTP ${e.status}`);
    const apiMsg = e.response?.data?.message;
    const msg = apiMsg || e.message;
    if (msg) parts.push(msg);
    if (e.name === "AbortError" || (e.message && /aborted/i.test(e.message))) {
      parts.push(`(timed out after ${GH_REQUEST_TIMEOUT_MS / 1000}s)`);
    }
    if (parts.length > 0) return parts.join(": ");
  }
  return String(err);
}
