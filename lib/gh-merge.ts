// Mergeability probe for the task page's `Resolve merge` button. Fetches PR
// mergeability via the in-process Octokit client to learn whether a PR
// currently conflicts with its base, and what that base branch is. Kept
// tiny and pure-at-the-core so the parsing is unit-testable without any I/O.

import { parsePrUrl } from "./gh-url";
import { getOctokit } from "./github-client";

export type Mergeable = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";

export interface Mergeability {
  mergeable: Mergeable;
  baseRef: string | null;
}

const UNKNOWN: Mergeability = { mergeable: "UNKNOWN", baseRef: null };

/**
 * Parse a `{ mergeable, baseRefName }` JSON blob (the shape the old
 * `gh pr view --json mergeable,baseRefName` emitted). Any shape we don't
 * recognise collapses to UNKNOWN so the button fails closed (hidden) rather
 * than showing a bogus merge prompt. Kept as the unit-testable core.
 */
export function parseMergeability(raw: string): Mergeability {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }
  if (!obj || typeof obj !== "object") return UNKNOWN;
  const rec = obj as Record<string, unknown>;
  const m = typeof rec.mergeable === "string" ? rec.mergeable.toUpperCase() : "";
  const mergeable: Mergeable =
    m === "CONFLICTING" ? "CONFLICTING" : m === "MERGEABLE" ? "MERGEABLE" : "UNKNOWN";
  const baseRef =
    typeof rec.baseRefName === "string" && rec.baseRefName.trim()
      ? rec.baseRefName
      : null;
  return { mergeable, baseRef };
}

/**
 * Map REST `pulls.get`'s tri-state `mergeable` boolean to the gh enum string
 * that {@link parseMergeability} understands, so the pure parser stays the
 * single source of truth for the mapping.
 */
function ghMergeableString(mergeable: boolean | null | undefined): string {
  if (mergeable === true) return "MERGEABLE";
  if (mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}

/** Fetch a PR's mergeability via Octokit; UNKNOWN on any failure. */
export async function prMergeability(prUrl: string): Promise<Mergeability> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return UNKNOWN;
  try {
    const { data: pr } = await getOctokit().pulls.get({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
    });
    return parseMergeability(
      JSON.stringify({
        mergeable: ghMergeableString(pr.mergeable),
        baseRefName: (pr.base as { ref?: string } | null)?.ref ?? null,
      })
    );
  } catch {
    return UNKNOWN;
  }
}
