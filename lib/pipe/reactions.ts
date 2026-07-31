// lib/pipe/reactions.ts
//
// The reaction vocabulary (PRD §6, "reactions as input"), declared away from
// any transport so both the Discord adapter (which receives them) and the agent
// loop (which decides what they mean) can name the same glyphs without the loop
// importing discord.js.
//
//   ❌  stop — interrupt the turn, or (on a relay breadcrumb) cancel that run
//   👍  yes — answer a pending persona question, or confirm a gated verb
//   👎  no  — answer a pending persona question
//   👀  the persona's own "I heard you, this is taking a moment" ack
//
// Anything else is ignored: a thread full of 🎉 must never become agent turns.

export const STOP_REACTION = "❌";
export const YES_REACTION = "👍";
export const NO_REACTION = "👎";
export const ACK_REACTION = "👀";

/** Inbound reactions that carry meaning, mapped to the text they stand for. */
export const INPUT_REACTIONS = new Map<string, string>([
  [STOP_REACTION, "/stop"],
  [YES_REACTION, "yes"],
  [NO_REACTION, "no"],
]);
