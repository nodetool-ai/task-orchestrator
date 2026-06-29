import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
};

export default nextConfig;
