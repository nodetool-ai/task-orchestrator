// Read model behind the concierge homepage (`/`).
//
// Home is a conversation, not a dashboard: the only thing it needs from the
// database is "which conversations do I have, and does any of them want me?".
// Everything here is a pure function over the same RunIndexRow[] the /runs
// index already loads (lib/run-overview.ts), so the homepage adds no new
// queries and can never disagree with /runs about what a conversation is.
//
// A conversation is a root chat run (goal '<chat>'). The work it delegated is
// its descendant runs — the concierge spawns specialists rather than asking the
// user to operate them, so home reports one outcome-level state per
// conversation and never one row per specialist.

import {
  buildRunForest,
  kindForRun,
  latestActivity,
  runHeading,
  type RunIndexRow,
  type RunTreeNode,
} from "./run-index";

/** Outcome-level state of one conversation, in the user's language. */
export type ConversationState = "needs_you" | "in_motion" | "ready" | "quiet";

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string | null> = {
  needs_you: "Needs you",
  in_motion: "In motion",
  ready: "Ready",
  // A settled conversation says nothing rather than wearing a badge.
  quiet: null,
};

export interface ConversationCard {
  id: number;
  title: string;
  state: ConversationState;
  stateLabel: string | null;
  /** Most recent activity anywhere in the conversation, ISO. */
  updatedAt: string;
  repoName: string | null;
  /** Runs the concierge delegated under this conversation (root excluded). */
  delegated: number;
}

const ACTIVE = new Set(["preparing", "running"]);
const ATTENTION = new Set(["failed", "budget_exhausted"]);

/** How long a finished outcome keeps saying "Ready" before going quiet. */
export const READY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function walk(node: RunTreeNode, visit: (run: RunIndexRow, isRoot: boolean) => void, isRoot = true) {
  visit(node.run, isRoot);
  for (const child of node.children) walk(child, visit, false);
}

function stateForTree(node: RunTreeNode, now: number): ConversationState {
  let attention = false;
  let active = false;
  let delivered = false;
  walk(node, (run, isRoot) => {
    if (ATTENTION.has(run.status)) attention = true;
    if (ACTIVE.has(run.status)) active = true;
    // Only delegated work "delivers" — an idle chat run is just a conversation
    // waiting for its next message, not a result to review.
    if (!isRoot && run.status === "completed") delivered = true;
  });

  // Ordering matters: a conversation that needs the user must not also read as
  // "in motion" (PRD §11.2), and work still running outranks an older result.
  if (attention) return "needs_you";
  if (active) return "in_motion";
  if (delivered && now - latestActivity(node) < READY_WINDOW_MS) return "ready";
  return "quiet";
}

function countDelegated(node: RunTreeNode): number {
  let n = 0;
  for (const child of node.children) n += 1 + countDelegated(child);
  return n;
}

/**
 * The conversations to offer on home, most recently active first, with the
 * attention-worthy ones lifted to the top.
 */
export function selectConversations(
  rows: RunIndexRow[],
  opts: { limit?: number; now?: number } = {}
): ConversationCard[] {
  const limit = opts.limit ?? 6;
  const now = opts.now ?? Date.now();

  const cards = buildRunForest(rows)
    .filter((tree) => kindForRun(tree.run) === "chat")
    .map((tree) => {
      const state = stateForTree(tree, now);
      return {
        id: tree.run.id,
        title: runHeading(tree.run),
        state,
        stateLabel: CONVERSATION_STATE_LABEL[state],
        updatedAt: new Date(latestActivity(tree)).toISOString(),
        repoName: tree.run.repoName,
        delegated: countDelegated(tree),
      } satisfies ConversationCard;
    });

  const rank: Record<ConversationState, number> = {
    needs_you: 0,
    in_motion: 1,
    ready: 2,
    quiet: 3,
  };
  cards.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
  return cards.slice(0, limit);
}

/**
 * The one quiet line home is allowed to say about everything else: how many
 * conversations want the user, and how many are moving on their own. Counted
 * across every conversation, not just the ones rendered.
 */
export function conversationPulse(
  rows: RunIndexRow[],
  opts: { now?: number } = {}
): { needsYou: number; inMotion: number; total: number } {
  const cards = selectConversations(rows, { limit: Number.MAX_SAFE_INTEGER, ...opts });
  return {
    needsYou: cards.filter((c) => c.state === "needs_you").length,
    inMotion: cards.filter((c) => c.state === "in_motion").length,
    total: cards.length,
  };
}
