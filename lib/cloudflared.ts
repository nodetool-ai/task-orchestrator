// Resolve a runnable `cloudflared` for the worktree-dev quick tunnel.
//
// A Cloudflare "quick tunnel" (`cloudflared tunnel --url http://127.0.0.1:PORT`)
// fronts a loopback dev server with a random, unguessable HTTPS
// *.trycloudflare.com URL — no account or DNS config required. The only
// prerequisite is the cloudflared binary, which we resolve in this order:
//
//   1. $CLOUDFLARED_PATH, if it points at an existing file
//   2. `cloudflared` already on $PATH
//   3. a cached copy we downloaded previously
//   4. download the official release binary into a shared user cache
//
// Pinned via $CLOUDFLARED_VERSION (default "latest"). The download is best-effort
// and surfaces a clear error so the caller can fall back to loopback-only.

import { spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLOUDFLARED_VERSION = process.env.CLOUDFLARED_VERSION || "latest";

/**
 * Release asset name for a platform/arch. Linux ships a raw executable we can
 * run directly; other platforms package it (tgz/exe) and aren't auto-installed
 * here — callers get a clear error pointing at a manual install.
 */
export function cloudflaredAssetName(platform: NodeJS.Platform, arch: string): string {
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const a = archMap[arch];
  if (!a) throw new Error(`Unsupported CPU arch for cloudflared: ${arch}`);
  if (platform === "linux") return `cloudflared-linux-${a}`;
  throw new Error(
    `Auto-install of cloudflared is only supported on linux (this is ${platform}). ` +
      `Install it manually and re-run, or set CLOUDFLARED_PATH.`
  );
}

/** GitHub release download URL for the binary. */
export function cloudflaredDownloadUrl(
  version: string,
  platform: NodeJS.Platform,
  arch: string
): string {
  const asset = cloudflaredAssetName(platform, arch);
  const base = "https://github.com/cloudflare/cloudflared/releases";
  return version === "latest"
    ? `${base}/latest/download/${asset}`
    : `${base}/download/${version}/${asset}`;
}

/** Versioned cache path so pinning a new version re-downloads cleanly. */
export function cloudflaredCachePath(
  version: string,
  platform: NodeJS.Platform,
  arch: string
): string {
  const asset = cloudflaredAssetName(platform, arch);
  return join(homedir(), ".cache", "task-orchestrator", "cloudflared", version, asset);
}

/** True when a working `cloudflared` is already on PATH. */
function onPath(): boolean {
  const res = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  return res.status === 0;
}

export interface ResolvedCloudflared {
  /** Command/path to invoke. */
  path: string;
  /** How it was found, for logging. */
  source: "env" | "path" | "cache" | "download";
}

/**
 * Resolve a runnable cloudflared, downloading the release binary into a shared
 * user cache if necessary. Throws (with a clear message) only when no binary is
 * available and the download fails — callers should catch and fall back to
 * loopback-only serving.
 */
export async function resolveCloudflared(
  opts: { version?: string; platform?: NodeJS.Platform; arch?: string } = {}
): Promise<ResolvedCloudflared> {
  const version = opts.version ?? CLOUDFLARED_VERSION;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  const override = process.env.CLOUDFLARED_PATH;
  if (override && existsSync(override)) return { path: override, source: "env" };

  if (onPath()) return { path: "cloudflared", source: "path" };

  const dest = cloudflaredCachePath(version, platform, arch);
  if (existsSync(dest)) return { path: dest, source: "cache" };

  await downloadCloudflared(cloudflaredDownloadUrl(version, platform, arch), dest);
  return { path: dest, source: "download" };
}

/** Download to a temp sibling then atomically rename in, and mark executable. */
async function downloadCloudflared(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  // Use curl: it's universally present on linux and already configured for this
  // environment's outbound proxy + CA bundle, unlike a raw fetch.
  const res = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", tmp, url], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (res.status !== 0) {
    await rm(tmp, { force: true });
    throw new Error(
      `Failed to download cloudflared from ${url} (curl exited ${res.status ?? "?"}).`
    );
  }
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
}
