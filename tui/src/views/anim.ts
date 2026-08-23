// The animation clock. One interval for the whole cockpit, subscribed to by
// the handful of things that move — the live line's glyph and glimmer, and
// the dot on a tool call that has not come back yet. Same discipline as
// Claude Code's `useAnimationFrame`: every animation reads the same clock, so
// they stay in step, and the clock only runs while something is watching it.
//
// Ink-free: these are React hooks over a plain timer, and nothing here paints.

import { useSyncExternalStore } from "react";

/** 20 fps. Fast enough for a glimmer, slow enough to leave the terminal alone. */
export const TICK_MS = 50;

const listeners = new Set<() => void>();
let handle: ReturnType<typeof setInterval> | null = null;
let started = 0;
let time = 0;

function tick(): void {
  time = Date.now() - started;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (handle === null) {
    started = Date.now();
    time = 0;
    handle = setInterval(tick, TICK_MS);
    // A cockpit that is only animating is a cockpit that should still be able
    // to exit: the clock must never be the last thing holding the loop open.
    (handle as { unref?: () => void }).unref?.();
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && handle !== null) {
      clearInterval(handle);
      handle = null;
    }
  };
}

function snapshot(): number {
  return time;
}

function still(): () => void {
  return () => {};
}

function zero(): number {
  return 0;
}

/**
 * Milliseconds since the clock started, or a frozen 0 when this component has
 * asked not to animate. Only the subscribing component re-renders, which is
 * why the live line and the transcript take the clock separately.
 */
export function useClock(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : still, enabled ? snapshot : zero, zero);
}

/** The default blink, copied from Claude Code: 600 ms on, 600 ms off. */
export const BLINK_MS = 600;

/**
 * True on the visible half of the cycle. Disabled means always visible — a
 * mark that never comes back is worse than one that never moves.
 *
 * The phase, not the time, is the snapshot: a caller of `useClock` re-renders
 * twenty times a second, and the transcript is the one subtree that must not.
 * React skips the render when the boolean is unchanged, so this costs two
 * renders a second instead of twenty.
 */
export function useBlink(enabled: boolean, intervalMs: number = BLINK_MS): boolean {
  return useSyncExternalStore(
    enabled ? subscribe : still,
    enabled ? () => Math.floor(snapshot() / intervalMs) % 2 === 0 : visible,
    visible,
  );
}

function visible(): boolean {
  return true;
}

// ── The live line's arithmetic ─────────────────────────────────────────────
// Pure functions of the clock, kept out of the component so the suite can
// step them without a renderer.

/** How long one spinner frame is held (Claude Code: `Math.floor(time / 120)`). */
export const FRAME_MS = 120;
/** How fast the glimmer crosses the verb, in ms per column. */
export const GLIMMER_MS = 200;
/** Columns of runway on each side, so the highlight leaves before it turns. */
export const RUNWAY = 10;

/**
 * The mark this frame. The list is played forwards and then backwards, so the
 * asterisk grows and shrinks rather than snapping back to a dot every cycle.
 * The last frame is the still mark: with motion off, that is what is drawn.
 */
export function spinnerFrame(time: number, frames: readonly string[]): string {
  if (frames.length === 0) return " ";
  const cycle = frames.length * 2;
  const i = Math.floor(Math.max(0, time) / FRAME_MS) % cycle;
  return (i < frames.length ? frames[i] : frames[cycle - 1 - i]) as string;
}

/** Where the highlight sits, in columns, this frame. It sweeps right to left
 *  across the verb and then off it — the direction Claude Code uses for every
 *  mode but `requesting`. */
export function glimmerAt(time: number, width: number): number {
  const cycle = Math.max(1, width + 2 * RUNWAY);
  return width + RUNWAY - (Math.floor(Math.max(0, time) / GLIMMER_MS) % cycle);
}
