// lib/extensions/repo-read.ts
//
// Read-only repository tools for lightweight chat and profile-backed runs.
// These intentionally expose narrow git/file reads instead of a shell.

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type { ExtensionFactory } from "./types";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
// Hard ceiling on captured git stdout before we kill the child. Set to the
// largest max_bytes any tool advertises (1 MB) so read_diff/show_commit/blame
// still have enough bytes for truncate() to honor their declared cap.
const OUTPUT_KILL_CEILING_BYTES = 1024 * 1024;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveP) => {
    const child = spawn("git", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let done = false;
    let killedForBytes = false;
    const finish = (result: GitResult) => {
      if (done) return;
      done = true;
      resolveP(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr: `${stderr}\ngit ${args[0]} timed out` });
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > OUTPUT_KILL_CEILING_BYTES && !killedForBytes) {
        killedForBytes = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A kill triggered solely by the byte ceiling is not a git failure: report
      // success with the accumulated stdout so callers truncate() it gracefully
      // instead of surfacing a bogus "exit -1" for large-but-valid output.
      if (killedForBytes) finish({ code: 0, stdout, stderr });
      else finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

function safeRepoPath(cwd: string, rawPath: string): { ok: true; path: string; rel: string } | { ok: false; error: string } {
  if (!rawPath || rawPath.includes("\0")) return { ok: false, error: "path must be a non-empty repository-relative path." };
  if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return { ok: false, error: "path must be repository-relative, not absolute." };
  }
  const full = resolve(cwd, rawPath);
  const rel = relative(cwd, full);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    return { ok: false, error: "path must stay inside the repository root." };
  }
  return { ok: true, path: full, rel };
}

function sliceLines(text: string, startLine?: number, maxLines?: number): string {
  if (!startLine && !maxLines) return text;
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1) - 1;
  const end = maxLines && maxLines > 0 ? start + Math.min(maxLines, 5000) : lines.length;
  return lines.slice(start, end).join("\n");
}

function safeRef(rawRef: unknown): string | null {
  if (typeof rawRef !== "string" || !rawRef.trim()) return "HEAD";
  const ref = rawRef.trim();
  if (ref.startsWith("-") || ref.includes("\0")) return null;
  return ref;
}

function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function treeForPath(root: string, startPath: string, maxDepth: number, maxEntries: number) {
  const out: Array<{ path: string; type: "file" | "dir" }> = [];
  async function visit(dir: string, depth: number) {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = resolve(dir, entry.name);
      const rel = relative(root, full);
      if (rel.startsWith(`..${sep}`) || rel === "..") continue;
      if (entry.isDirectory()) {
        out.push({ path: `${rel}/`, type: "dir" });
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        out.push({ path: rel, type: "file" });
      }
    }
  }
  await visit(startPath, 1);
  return out;
}

export interface RepoReadExtensionOptions {
  cwd: string;
}

export const repoReadExtension =
  ({ cwd }: RepoReadExtensionOptions): ExtensionFactory =>
  (reg) => {
    reg.registerTool({
      name: "repo__list_files",
      label: "List Repo Files",
      description:
        "List tracked and untracked non-ignored files in the current repository. Optionally pass a repository-relative path prefix.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Repository-relative path prefix to list under." })),
        max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      }),
      execute: async (_id, { path, max_files }) => {
        const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          args.push("--", checked.rel);
        }
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git ls-files failed (exit ${result.code})`);
        const limit = Math.min(max_files ?? 500, 2000);
        const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
        return ok(JSON.stringify({ files, truncated: files.length < result.stdout.split(/\r?\n/).filter(Boolean).length }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__read_file",
      label: "Read Repo File",
      description:
        "Read a repository-relative file. Use start_line and max_lines to inspect large files in chunks.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        start_line: Type.Optional(Type.Integer({ minimum: 1 })),
        max_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
      }),
      execute: async (_id, { path, start_line, max_lines }) => {
        const checked = safeRepoPath(cwd, path);
        if (!checked.ok) return errResult(checked.error);
        let data: Buffer;
        try {
          data = await readFile(checked.path);
        } catch (err) {
          return errResult(err instanceof Error ? err.message : String(err));
        }
        if (data.byteLength > MAX_FILE_BYTES && !max_lines) {
          return errResult(`File is ${data.byteLength} bytes; pass start_line and max_lines to read it in chunks.`);
        }
        const text = data.toString("utf8");
        return ok(sliceLines(text, start_line, max_lines));
      },
    });

    reg.registerTool({
      name: "repo__search",
      label: "Search Repo",
      description:
        "Search text in the local checkout with git grep. Pass a literal query or a git-grep regex pattern.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String({ description: "Repository-relative path prefix to search under." })),
        case_sensitive: Type.Optional(Type.Boolean()),
        max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      execute: async (_id, { query, path, case_sensitive, max_matches }) => {
        if (typeof query !== "string" || query.startsWith("-") || query.includes("\0")) {
          return errResult("query must be non-empty and cannot be a git option.");
        }
        const args = ["grep", "-n", "--break", "--heading"];
        if (case_sensitive !== true) args.push("-i");
        args.push("-e", query, "--");
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          args.push(checked.rel);
        }
        const result = await git(args, cwd);
        if (result.code !== 0 && result.code !== 1) {
          return errResult(result.stderr.trim() || `git grep failed (exit ${result.code})`);
        }
        const lines = result.stdout.split(/\r?\n/).filter(Boolean);
        const limit = Math.min(max_matches ?? 100, 500);
        return ok(JSON.stringify({
          matches: lines.slice(0, limit),
          truncated: lines.length > limit,
        }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__file_tree",
      label: "Repo File Tree",
      description:
        "Return a directory-oriented tree for a repository-relative path in the local checkout.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Repository-relative directory. Defaults to repository root." })),
        max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        max_entries: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      }),
      execute: async (_id, { path, max_depth, max_entries }) => {
        let startPath = cwd;
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          startPath = checked.path;
        }
        if (!(await pathExists(startPath))) return errResult(`Path does not exist: ${path ?? "."}`);
        const limit = Math.min(max_entries ?? 500, 2000);
        const entries = await treeForPath(cwd, startPath, Math.min(max_depth ?? 3, 8), limit);
        return ok(JSON.stringify({ entries, truncated: entries.length >= limit }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__list_branches",
      label: "List Branches",
      description: "List local and remote git branches for the current repository.",
      parameters: Type.Object({
        all: Type.Optional(Type.Boolean({ description: "Include remote branches. Defaults to true." })),
        max_branches: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      execute: async (_id, { all, max_branches }) => {
        const args = ["branch", all === false ? "--list" : "--all", "--format=%(refname:short)|%(objectname:short)|%(committerdate:iso8601)|%(upstream:short)"];
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git branch failed (exit ${result.code})`);
        const branches = result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, Math.min(max_branches ?? 200, 500))
          .map((line) => {
            const [name, commit, updated_at, upstream] = line.split("|");
            return { name, commit, updated_at, upstream: upstream || null };
          });
        return ok(JSON.stringify({ branches }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__read_diff",
      label: "Read Diff",
      description:
        "Read a local git diff. Defaults to unstaged working tree changes; pass staged=true for staged changes or base/head for a revision diff.",
      parameters: Type.Object({
        base: Type.Optional(Type.String({ description: "Base branch/commit for a revision diff." })),
        head: Type.Optional(Type.String({ description: "Head branch/commit for a revision diff. Defaults to HEAD when base is set." })),
        path: Type.Optional(Type.String({ description: "Repository-relative path to filter the diff." })),
        staged: Type.Optional(Type.Boolean({ description: "Read staged diff instead of unstaged working tree diff." })),
        max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1048576 })),
      }),
      execute: async (_id, { base, head, path, staged, max_bytes }) => {
        const args = ["diff", "--no-ext-diff"];
        const safeBase = safeRef(base);
        const safeHead = typeof head === "string" && head.trim() ? safeRef(head) : "HEAD";
        if (typeof base === "string" && base.trim()) {
          if (!safeBase || !safeHead) return errResult("base/head must be revisions, not git options.");
          args.push(`${safeBase}...${safeHead}`);
        } else if (staged === true) {
          args.push("--staged");
        }
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          args.push("--", checked.rel);
        }
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git diff failed (exit ${result.code})`);
        const capped = truncate(result.stdout, Math.min(max_bytes ?? MAX_OUTPUT_BYTES, 1024 * 1024));
        return ok(JSON.stringify({ diff: capped.text, truncated: capped.truncated }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__read_commits",
      label: "Read Commits",
      description:
        "Read recent commits from the current repository, optionally scoped to a ref or path.",
      parameters: Type.Object({
        ref: Type.Optional(Type.String({ description: "Branch, tag, or revision range. Defaults to HEAD." })),
        path: Type.Optional(Type.String({ description: "Repository-relative path to filter commits by." })),
        max_commits: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, { ref, path, max_commits }) => {
        const limit = Math.min(max_commits ?? 20, 100);
        const rev = safeRef(ref);
        if (!rev) return errResult("ref must be a branch, tag, commit, or revision range, not a git option.");
        const args = [
          "log",
          `--max-count=${limit}`,
          "--date=iso-strict",
          "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s",
          rev,
        ];
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          args.push("--", checked.rel);
        }
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git log failed (exit ${result.code})`);
        const commits = result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [sha, short_sha, author_name, author_email, authored_at, subject] = line.split("\x1f");
            return { sha, short_sha, author_name, author_email, authored_at, subject };
          });
        return ok(JSON.stringify({ commits }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__show_commit",
      label: "Show Commit",
      description:
        "Read one commit's metadata and optionally its patch from the local checkout.",
      parameters: Type.Object({
        ref: Type.String({ minLength: 1, description: "Commit SHA, branch, tag, or other revision." }),
        path: Type.Optional(Type.String({ description: "Repository-relative path to filter the commit patch." })),
        include_patch: Type.Optional(Type.Boolean()),
        max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1048576 })),
      }),
      execute: async (_id, { ref, path, include_patch, max_bytes }) => {
        const rev = safeRef(ref);
        if (!rev) return errResult("ref must be a revision, not a git option.");
        const args = [
          "show",
          "--no-ext-diff",
          "--date=iso-strict",
          include_patch === false ? "--no-patch" : "--patch",
          "--stat",
          "--pretty=fuller",
          rev,
        ];
        if (typeof path === "string" && path.trim()) {
          const checked = safeRepoPath(cwd, path.trim());
          if (!checked.ok) return errResult(checked.error);
          args.push("--", checked.rel);
        }
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git show failed (exit ${result.code})`);
        const capped = truncate(result.stdout, Math.min(max_bytes ?? MAX_OUTPUT_BYTES, 1024 * 1024));
        return ok(JSON.stringify({ commit: capped.text, truncated: capped.truncated }, null, 2));
      },
    });

    reg.registerTool({
      name: "repo__blame",
      label: "Blame File",
      description:
        "Read git blame for a repository-relative file, optionally bounded to a line range.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        start_line: Type.Optional(Type.Integer({ minimum: 1 })),
        end_line: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, { path, start_line, end_line }) => {
        const checked = safeRepoPath(cwd, path);
        if (!checked.ok) return errResult(checked.error);
        const args = ["blame", "--date=iso"];
        if (start_line != null || end_line != null) {
          const start = Math.max(1, start_line ?? 1);
          const end = Math.max(start, end_line ?? start + 199);
          args.push("-L", `${start},${end}`);
        }
        args.push("--", checked.rel);
        const result = await git(args, cwd);
        if (result.code !== 0) return errResult(result.stderr.trim() || `git blame failed (exit ${result.code})`);
        const capped = truncate(result.stdout);
        return ok(JSON.stringify({ blame: capped.text, truncated: capped.truncated }, null, 2));
      },
    });
  };
