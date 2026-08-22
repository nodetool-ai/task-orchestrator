import { defineConfig } from "vitest/config";

// The TUI suite is hermetic: no database, no server. Client tests stand up a
// throwaway http server on a loopback port and point the client at it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
