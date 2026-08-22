import { defineConfig } from "vitest/config";

// The TUI suite is hermetic: no database, no server. Client tests stand up a
// throwaway http server on a loopback port and point the client at it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  css: {
    // The cockpit has no stylesheets, but Vite still searches upward for a
    // PostCSS config and finds the Next app's at the repo root — which needs
    // tailwindcss, a dependency this package does not have. An inline config
    // stops the search; without it the suite passes locally (root node_modules
    // is present) and dies in CI, where only tui/ is installed.
    postcss: { plugins: [] },
  },
});
