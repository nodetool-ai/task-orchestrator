// lib/extensions/delegation.ts
//
// Append the delegation rule (lib/delegation-guidance.ts) to the run's system
// prompt. Mounted from profiles.alwaysOnExtensions, not from a persona prompt,
// for two reasons:
//
//   - personas live in the database and are editable in the UI, so prompt text
//     baked into lib/personas/*.ts only reaches deployments that re-seed; and
//   - the ws worker path (lib/worker-runtime/context.ts) mounts profile +
//     always-on factories and nothing else, so an always-on transform is the
//     only seam that reaches containerized runs, in-process postgres turns and
//     the legacy runner alike.
//
// It APPENDS (persona-prompt.ts prepends) so the persona still leads the prompt.

import type { ExtensionFactory } from "./types";
import { delegationGuidanceFor, type DelegationRun } from "../delegation-guidance";

export const delegationGuidanceFactory =
  (run: DelegationRun): ExtensionFactory =>
  (reg) => {
    const guidance = delegationGuidanceFor(run).trim();
    reg.transformSystemPrompt((base) =>
      base.length > 0 ? `${base}\n\n${guidance}` : guidance
    );
  };
