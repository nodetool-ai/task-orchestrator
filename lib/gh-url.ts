// Shared GitHub URL parsing & repo validation used by gh_pr and gh_ci MCP
// servers. Originally lived inside lib/gh-pr-mcp.ts; extracted so the CI
// helper can gate on the same canonical owner/repo lookup without forcing
// either family to import the other's server module.

import { listRepositories } from "./repo";

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
  /** Canonical https URL — useful when callers pass short forms. */
  canonical: string;
}

const HTTPS_PR_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/pull\/(\d+)(?:[/?#].*)?$/;
const SHORT_PR_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?#(\d+)$/;

export function parsePrUrl(input: string): ParsedPrUrl | null {
  const trimmed = input.trim();
  let m = trimmed.match(HTTPS_PR_RE);
  if (!m) m = trimmed.match(SHORT_PR_RE);
  if (!m) return null;
  const [, owner, repoRaw, numStr] = m;
  const repoName = repoRaw.replace(/\.git$/, "");
  const number = parseInt(numStr, 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    owner,
    repo: repoName,
    number,
    canonical: `https://github.com/${owner}/${repoName}/pull/${number}`,
  };
}

// Extract owner/repo from a git remote URL. Supports:
//   git@github.com:owner/repo.git
//   ssh://git@github.com/owner/repo.git
//   https://github.com/owner/repo(.git)?
// Returns null if the remote isn't a GitHub URL we recognise.
export function ownerRepoFromRemote(
  remote: string | null
): { owner: string; repo: string } | null {
  if (!remote) return null;
  const r = remote.trim();
  if (!r) return null;
  // git@github.com:owner/repo(.git)
  let m = r.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // ssh://git@github.com/owner/repo(.git)
  m = r.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo(.git)?
  m = r.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/**
 * GitHub web URL for a branch (`…/tree/<branch>`), from the repo's git remote.
 * Null when the remote is missing or isn't a recognisable GitHub URL — callers
 * fall back to plain-text display.
 */
export function branchUrlFromRemote(remote: string | null, branch: string): string | null {
  const parsed = ownerRepoFromRemote(remote);
  if (!parsed) return null;
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${encodeURIComponent(branch)}`;
}

export interface UrlValidation {
  parsed: ParsedPrUrl;
  matched: { id: string; name: string };
}

// Validates that `input` resolves to a PR in a repository the orchestrator
// knows about. Returns either the parsed URL + the matched repo, or a string
// error explaining the rejection.
export async function validatePrUrl(
  input: string,
  listRepos: () => Promise<Array<{ id: string; name: string; remote: string | null }>> = listRepositories
): Promise<UrlValidation | { error: string }> {
  const parsed = parsePrUrl(input);
  if (!parsed) {
    return {
      error: `Could not parse PR url '${input}'. Expected https://github.com/<owner>/<repo>/pull/<n> or <owner>/<repo>#<n>.`,
    };
  }
  const wantOwner = parsed.owner.toLowerCase();
  const wantRepo = parsed.repo.toLowerCase();
  const known = await listRepos();
  for (const r of known) {
    const or = ownerRepoFromRemote(r.remote);
    if (!or) continue;
    if (or.owner.toLowerCase() === wantOwner && or.repo.toLowerCase() === wantRepo) {
      return { parsed, matched: { id: r.id, name: r.name } };
    }
  }
  return {
    error: `PR ${parsed.owner}/${parsed.repo}#${parsed.number} is not in a repository registered with the orchestrator. Register the repo (with its github remote) before operating on it.`,
  };
}
