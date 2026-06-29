import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Webpack's filesystem cache normally lives in each checkout's .next/cache, so
// every git worktree builds cold. Point it at one shared directory instead:
// webpack keys entries by content + config hash, so worktrees and the canonical
// checkout safely reuse each other's compiled modules (mismatches are ignored,
// never corrupted). Split dev/prod so the two modes don't churn one cache.
const SHARED_WEBPACK_CACHE =
  process.env.NEXT_WEBPACK_CACHE_DIR ?? join(homedir(), ".cache", "task-orch-webpack");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: [
    "better-sqlite3",
    // Pi packages ship a bundled jiti for runtime TS loading; if Next webpack
    // tries to bundle them, it stubs node:os/node:path as MODULE_NOT_FOUND
    // throws and the prod server hard-crashes at first import.
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    // The Claude Agent SDK bundles a native CLI binary; same bundling hazard as
    // the pi packages, so keep it external too.
    "@anthropic-ai/claude-agent-sdk",
    // isomorphic-dompurify pulls in jsdom, which reads data files (e.g.
    // browser/default-stylesheet.css) via __dirname-relative paths. Bundling
    // rewrites those paths and the asset goes missing at runtime — surfaced as
    // a hard build failure under pnpm's symlinked store layout. Keep both
    // external so they load from node_modules.
    "isomorphic-dompurify",
    "jsdom",
  ],
  webpack: (config, { dev }) => {
    if (config.cache && config.cache.type === "filesystem") {
      config.cache.cacheDirectory = join(SHARED_WEBPACK_CACHE, dev ? "dev" : "prod");
    }
    return config;
  },
};

export default nextConfig;
