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
    // dockerode (the server spawns/stops worker containers via the Docker socket)
    // pulls in ssh2, whose native `sshcrypto.node` binary webpack can't parse and
    // fails the build. It must be required from node_modules at runtime, not
    // bundled — same hazard and same fix as better-sqlite3.
    "dockerode",
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
  ],
};

export default nextConfig;
