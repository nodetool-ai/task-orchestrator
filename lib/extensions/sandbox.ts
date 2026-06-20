// lib/extensions/sandbox.ts
//
// Filesystem sandbox via the backend's tool-call interceptor. Two invariants,
// enforced identically on every backend:
//   1. write/edit tool paths must resolve inside cwd.
//   2. bash subprocesses see the run-scoped TASK_ORCH_DB env var so they
//      cannot mutate the host data.db.
// Built-in tool calls reach the interceptor in a canonical vocabulary
// (write/edit → input.path, bash → input.command); each backend adapter maps
// its SDK's names/params onto that.

import path from "node:path";
import type { ExtensionFactory } from "./types";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const sandboxFactory =
  (cwd: string, sandboxDbPath: string): ExtensionFactory =>
  (reg) => {
    // Normalize the root once. The containment check below compares against
    // `root + path.sep`, so a caller-supplied `cwd` that is relative or carries
    // a trailing slash would otherwise mis-judge containment (a trailing slash
    // turns `root + sep` into `…//`, rejecting every legitimate write).
    const root = path.resolve(cwd);
    reg.interceptToolCall((event) => {
      if (event.toolName === "write" || event.toolName === "edit") {
        const target = event.input?.path;
        if (typeof target !== "string") return;
        const abs = path.resolve(root, target);
        const inside = abs === root || abs.startsWith(root + path.sep);
        if (!inside) {
          return { block: true, reason: `Write outside ${root} denied` };
        }
        return;
      }
      if (event.toolName === "bash" && typeof event.input?.command === "string") {
        return {
          input: {
            command:
              `export TASK_ORCH_DB=${shellEscape(sandboxDbPath)}\n` +
              event.input.command,
          },
        };
      }
    });
  };
