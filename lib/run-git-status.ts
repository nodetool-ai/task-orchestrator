// lib/run-git-status.ts
//
// Git working-state snapshot for a run's checkout: which files the run
// touched and how many lines it added and removed. Two change sets are
// reported separately because they answer different questions:
//
//   committed — `<merge-base>..HEAD`, i.e. what the run has already committed
//               on its branch relative to the base it forked from. This is
//               what the PR will contain.
//   working   — everything not yet committed: staged, unstaged, and untracked
//               files, measured against HEAD.
//
// Only checkouts that live on THIS filesystem can be inspected. A run placed
// on a remote worker (Fly Machine, Sprite) keeps its worktree inside the
// container, so the snapshot reports `available: false` with a reason rather
// than silently describing the orchestrator's own checkout.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as repo from "@/lib/repo";
import type { RunRow } from "@/lib/runs";

/** One changed path. Line counts are null for binary files (git prints "-"). */
export interface GitFileChange {
  path: string;
  /** Previous path when git reported a rename or copy, else null. */
  oldPath: string | null;
  status: GitChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Working-set only: the change (or part of it) is in the index. */
  staged: boolean;
}

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked";

export interface GitChangeSet {
  files: GitFileChange[];
  additions: number;
  deletions: number;
  /** Files dropped because the set exceeded MAX_FILES. */
  truncated: number;
}

export interface RunGitStatus {
  available: boolean;
  /** Why the snapshot is empty, when `available` is false. */
  reason: string | null;
  /** The inspected checkout, for display. Null when unavailable. */
  cwd: string | null;
  branch: string | null;
  /** Base ref the committed set is measured against (as resolved). */
  base: string | null;
  /** Commits on HEAD that the base does not have. */
  ahead: number | null;
  committed: GitChangeSet;
  working: GitChangeSet;
}

/** Files per change set before we stop listing (totals still count them). */
const MAX_FILES = 500;
/** Largest untracked file we read to count its lines. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const EMPTY_SET = (): GitChangeSet => ({ files: [], additions: 0, deletions: 0, truncated: 0 });

function unavailable(reason: string, cwd: string | null = null): RunGitStatus {
  return {
    available: false,
    reason,
    cwd,
    branch: null,
    base: null,
    ahead: null,
    committed: EMPTY_SET(),
    working: EMPTY_SET(),
  };
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveP) => {
    // `--no-optional-locks` keeps these read-only commands from taking the
    // index lock: an agent is very likely running git in this same worktree.
    const child = spawn("git", ["--no-optional-locks", ...args], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: GitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr: `${stderr}\ngit ${args[0]} timed out` });
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: `${stderr}${String(err)}` }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

const trimmed = (r: GitResult): string | null =>
  r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;

/**
 * Resolve the checkout to inspect for a run, or explain why there isn't one
 * reachable from this process.
 */
export async function resolveRunCheckout(
  run: Pick<RunRow, "id" | "repoId" | "cwdStrategy" | "worktreePath">
): Promise<{ cwd: string } | { reason: string }> {
  if (run.cwdStrategy === "none") {
    return { reason: "This run has no repository checkout." };
  }
  const wantsWorktree = run.cwdStrategy === "worktree" || run.cwdStrategy === "worktree_at_pr";
  if (wantsWorktree) {
    if (!run.worktreePath) {
      return { reason: "This run has not checked out a worktree yet." };
    }
    if (!isDirectory(run.worktreePath)) {
      return {
        reason:
          `The run's worktree (${run.worktreePath}) is not on this host — ` +
          "it belongs to a remote worker.",
      };
    }
    return { cwd: run.worktreePath };
  }
  const row = run.repoId ? await repo.getRepository(run.repoId) : null;
  if (!row?.localPath) {
    return { reason: "This run's repository has no local checkout." };
  }
  if (!isDirectory(row.localPath)) {
    return { reason: `Repository path ${row.localPath} does not exist on this host.` };
  }
  return { cwd: row.localPath };
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Snapshot the git state of a run's checkout. Never throws. */
export async function runGitStatus(
  run: Pick<RunRow, "id" | "repoId" | "cwdStrategy" | "worktreePath" | "baseBranch" | "branch">
): Promise<RunGitStatus> {
  try {
    const checkout = await resolveRunCheckout(run);
    if ("reason" in checkout) return unavailable(checkout.reason);
    const repoRow = run.repoId ? await repo.getRepository(run.repoId) : null;
    const base = run.baseBranch ?? repoRow?.defaultBranch ?? null;
    return await collectGitStatus(checkout.cwd, base);
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read the committed and uncommitted change sets of a checkout. Exported for
 * tests and for callers that already know the directory.
 */
export async function collectGitStatus(
  cwd: string,
  baseBranch: string | null
): Promise<RunGitStatus> {
  const dir = resolve(cwd);
  const inside = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return unavailable(`${dir} is not a git checkout.`, dir);
  }

  const branch = trimmed(await git(["rev-parse", "--abbrev-ref", "HEAD"], dir));
  const hasHead = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir)).code === 0;

  const [committed, working] = await Promise.all([
    hasHead ? committedChanges(dir, baseBranch) : Promise.resolve({ set: EMPTY_SET(), base: null, ahead: null }),
    workingChanges(dir, hasHead),
  ]);

  return {
    available: true,
    reason: null,
    cwd: dir,
    branch: branch === "HEAD" ? null : branch,
    base: committed.base,
    ahead: committed.ahead,
    committed: committed.set,
    working,
  };
}

/** `<merge-base>..HEAD` — what this branch adds on top of its base. */
async function committedChanges(
  dir: string,
  baseBranch: string | null
): Promise<{ set: GitChangeSet; base: string | null; ahead: number | null }> {
  const mergeBase = baseBranch ? await resolveMergeBase(dir, baseBranch) : null;
  if (!mergeBase) return { set: EMPTY_SET(), base: null, ahead: null };
  const [numstat, nameStatus, revList] = await Promise.all([
    git(["diff", "--no-ext-diff", "--numstat", "-z", mergeBase.sha, "HEAD"], dir),
    git(["diff", "--no-ext-diff", "--name-status", "-z", mergeBase.sha, "HEAD"], dir),
    git(["rev-list", "--count", `${mergeBase.sha}..HEAD`], dir),
  ]);
  if (numstat.code !== 0) return { set: EMPTY_SET(), base: mergeBase.ref, ahead: null };
  const statuses = parseNameStatusZ(nameStatus.code === 0 ? nameStatus.stdout : "");
  const set = buildChangeSet(parseNumstatZ(numstat.stdout), statuses, false);
  const ahead = revList.code === 0 ? Number.parseInt(revList.stdout.trim(), 10) : NaN;
  return { set, base: mergeBase.ref, ahead: Number.isFinite(ahead) ? ahead : null };
}

/** The base ref may only exist as a remote-tracking branch in a worktree. */
async function resolveMergeBase(
  dir: string,
  baseBranch: string
): Promise<{ ref: string; sha: string } | null> {
  for (const ref of [baseBranch, `origin/${baseBranch}`]) {
    const found = trimmed(await git(["merge-base", ref, "HEAD"], dir));
    if (found) return { ref, sha: found };
  }
  return null;
}

/** Staged + unstaged + untracked, measured against HEAD. */
async function workingChanges(dir: string, hasHead: boolean): Promise<GitChangeSet> {
  const target = hasHead ? ["HEAD"] : [];
  const [numstat, nameStatus, porcelain] = await Promise.all([
    hasHead
      ? git(["diff", "--no-ext-diff", "--numstat", "-z", ...target], dir)
      : Promise.resolve({ code: 0, stdout: "", stderr: "" } as GitResult),
    hasHead
      ? git(["diff", "--no-ext-diff", "--name-status", "-z", ...target], dir)
      : Promise.resolve({ code: 0, stdout: "", stderr: "" } as GitResult),
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dir),
  ]);

  const porcelainRows = porcelain.code === 0 ? parsePorcelainZ(porcelain.stdout) : [];
  const stagedPaths = new Set(
    porcelainRows.filter((r) => r.staged).map((r) => r.path)
  );
  const set = buildChangeSet(
    numstat.code === 0 ? parseNumstatZ(numstat.stdout) : [],
    parseNameStatusZ(nameStatus.code === 0 ? nameStatus.stdout : ""),
    true,
    stagedPaths
  );

  // Untracked files never appear in `git diff`; count their lines as additions
  // so a run that only created files still reports what it wrote.
  const untracked = porcelainRows.filter((r) => r.untracked).map((r) => r.path);
  for (const path of untracked) {
    // Reading a file is the one unbounded cost here, so the cap gates the read
    // itself: a worktree full of untracked build output is counted, not read.
    if (set.files.length >= MAX_FILES) {
      set.truncated += 1;
      continue;
    }
    const counted = await countNewFileLines(dir, path);
    set.additions += counted.additions ?? 0;
    set.files.push({
      path,
      oldPath: null,
      status: "untracked",
      additions: counted.additions,
      deletions: counted.binary ? null : 0,
      binary: counted.binary,
      staged: false,
    });
  }
  set.files.sort((a, b) => a.path.localeCompare(b.path));
  return set;
}

/** Line count for a file git has never seen. Binary files report null. */
async function countNewFileLines(
  dir: string,
  relPath: string
): Promise<{ additions: number | null; binary: boolean }> {
  const full = resolve(dir, relPath);
  try {
    const stats = statSync(full);
    if (!stats.isFile()) return { additions: null, binary: false };
    if (stats.size > MAX_UNTRACKED_BYTES) return { additions: null, binary: true };
    if (stats.size === 0) return { additions: 0, binary: false };
    const buf = await readFile(full);
    if (buf.subarray(0, 8000).includes(0)) return { additions: null, binary: true };
    let lines = 0;
    for (let at = buf.indexOf(0x0a); at !== -1; at = buf.indexOf(0x0a, at + 1)) lines += 1;
    if (buf[buf.length - 1] !== 0x0a) lines += 1;
    return { additions: lines, binary: false };
  } catch {
    return { additions: null, binary: false };
  }
}

interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  path: string;
  oldPath: string | null;
}

/**
 * `git diff --numstat -z` records: "adds\tdels\tpath\0", or for a rename
 * "adds\tdels\t\0oldpath\0newpath\0" (the path field is empty and the two
 * paths follow as their own NUL-terminated fields).
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const fields = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const parts = field.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels, inlinePath] = parts;
    let path = inlinePath;
    let oldPath: string | null = null;
    if (!path) {
      oldPath = fields[i + 1] ?? "";
      path = fields[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    entries.push({
      additions: adds === "-" ? null : Number.parseInt(adds, 10) || 0,
      deletions: dels === "-" ? null : Number.parseInt(dels, 10) || 0,
      path,
      oldPath,
    });
  }
  return entries;
}

/**
 * `git diff --name-status -z`: a status field ("M", "A", "R096", …) followed
 * by one path, or two paths for renames and copies.
 */
export function parseNameStatusZ(out: string): Map<string, { status: GitChangeStatus; oldPath: string | null }> {
  const fields = out.split("\0").filter((f) => f !== "");
  const map = new Map<string, { status: GitChangeStatus; oldPath: string | null }>();
  for (let i = 0; i < fields.length; ) {
    const code = fields[i];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      if (newPath) {
        map.set(newPath, { status: letter === "R" ? "renamed" : "copied", oldPath: oldPath ?? null });
      }
      i += 3;
    } else {
      const path = fields[i + 1];
      if (path) map.set(path, { status: letterToStatus(letter), oldPath: null });
      i += 2;
    }
  }
  return map;
}

function letterToStatus(letter: string): GitChangeStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "T":
      return "typechange";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

interface PorcelainRow {
  path: string;
  staged: boolean;
  untracked: boolean;
}

/**
 * `git status --porcelain=v1 -z`: "XY path\0" per entry, with a rename adding
 * the original path as the next NUL-terminated field.
 */
export function parsePorcelainZ(out: string): PorcelainRow[] {
  const fields = out.split("\0");
  const rows: PorcelainRow[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const index = field[0];
    const tree = field[1];
    const path = field.slice(3);
    // A rename/copy in the index carries its source path as the next field.
    if (index === "R" || index === "C") i += 1;
    if (index === "?" && tree === "?") {
      rows.push({ path, staged: false, untracked: true });
      continue;
    }
    if (index === "!") continue;
    rows.push({ path, staged: index !== " " && index !== "?", untracked: false });
  }
  return rows;
}

function buildChangeSet(
  entries: NumstatEntry[],
  statuses: Map<string, { status: GitChangeStatus; oldPath: string | null }>,
  isWorking: boolean,
  stagedPaths?: Set<string>
): GitChangeSet {
  const set = EMPTY_SET();
  for (const entry of entries) {
    set.additions += entry.additions ?? 0;
    set.deletions += entry.deletions ?? 0;
    if (set.files.length >= MAX_FILES) {
      set.truncated += 1;
      continue;
    }
    const meta = statuses.get(entry.path);
    set.files.push({
      path: entry.path,
      oldPath: entry.oldPath ?? meta?.oldPath ?? null,
      status: meta?.status ?? "modified",
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.additions === null && entry.deletions === null,
      staged: isWorking ? stagedPaths?.has(entry.path) ?? false : false,
    });
  }
  set.files.sort((a, b) => a.path.localeCompare(b.path));
  return set;
}
