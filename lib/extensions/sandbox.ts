// lib/extensions/sandbox.ts
//
// Filesystem sandbox via pi's tool_call hook. Replaces the Claude SDK's
// always-on `sandbox: SANDBOX_OPTS`. Two invariants:
//   1. write/edit tool paths must resolve inside cwd.
//   2. bash subprocesses see the run-scoped TASK_ORCH_DB env var so they
//      cannot mutate the host data.db.

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const sandboxFactory =
  (cwd: string, sandboxDbPath: string): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event: any) => {
      if (event.toolName === "write" || event.toolName === "edit") {
        const target = event.input?.path;
        if (typeof target !== "string") return;
        const abs = path.resolve(cwd, target);
        const inside = abs === cwd || abs.startsWith(cwd + path.sep);
        if (!inside) {
          return { block: true, reason: `Write outside ${cwd} denied` };
        }
        return;
      }
      if (event.toolName === "bash" && typeof event.input?.command === "string") {
        event.input.command =
          `export TASK_ORCH_DB=${shellEscape(sandboxDbPath)}\n` +
          event.input.command;
      }
    });
  };
