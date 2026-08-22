// Server status vocabulary → the seven cockpit glyphs (PRD §6.2). The server
// has ten statuses; the cockpit has seven states, so this projection is lossy
// and must live in exactly one place.

import type { SessionStatus } from "../api/types.js";

export type TuiStatus =
  | "running"
  | "preparing"
  | "queued"
  | "parked" // ⚑ asks you — a human has to answer
  | "idle"
  | "done"
  | "failed";

export function toTuiStatus(status: SessionStatus, parkReason: string | null): TuiStatus {
  switch (status) {
    case "running":
      return "running";
    case "preparing":
      return "preparing";
    case "pending":
      return "queued";
    case "idle":
      return "idle";
    case "completed":
    case "closed":
      return "done";
    case "failed":
    case "cancelled":
    case "budget_exhausted":
      return "failed";
    case "parked":
      // Only a question needs a human; waiting/sleeping are just queued work.
      return parkReason === "question" ? "parked" : "queued";
    default: {
      const never: never = status;
      void never;
      // A status the server grew after this was written: show it as queued
      // rather than crashing the render.
      return "queued";
    }
  }
}

export function statusWord(s: TuiStatus): string {
  switch (s) {
    case "running":
      return "running";
    case "preparing":
      return "preparing";
    case "queued":
      return "queued";
    case "parked":
      return "asks you";
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

/** Live = still on the floor: not finished, not broken, not an idle chat. */
export function isLive(s: TuiStatus): boolean {
  return s !== "done" && s !== "failed" && s !== "idle";
}
