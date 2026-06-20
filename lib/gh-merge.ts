// Mergeability probe for the task page's `Resolve merge` button. Shells
// `gh pr view` to learn whether a PR currently conflicts with its base, and
// what that base branch is. Kept tiny and pure-at-the-core so the parsing is
// unit-testable without spawning gh.

import { spawn } from "node:child_process";

export type Mergeable = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";

export interface Mergeability {
  mergeable: Mergeable;
  baseRef: string | null;
}

const UNKNOWN: Mergeability = { mergeable: "UNKNOWN", baseRef: null };

/**
 * Parse `gh pr view --json mergeable,baseRefName` output. Any shape we don't
 * recognise collapses to UNKNOWN so the button fails closed (hidden) rather
 * than showing a bogus merge prompt.
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

/** Run `gh pr view <url>` and return its mergeability; UNKNOWN on any failure. */
export async function prMergeability(prUrl: string): Promise<Mergeability> {
  try {
    const raw = await new Promise<string>((res, rej) => {
      const child = spawn(
        "gh",
        ["pr", "view", prUrl, "--json", "mergeable,baseRefName"],
        { env: process.env }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", rej);
      child.on("close", (code) =>
        code === 0 ? res(out) : rej(new Error(err.trim() || `gh exited ${code}`))
      );
    });
    return parseMergeability(raw);
  } catch {
    return UNKNOWN;
  }
}
