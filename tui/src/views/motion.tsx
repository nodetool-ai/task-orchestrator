import React, { createContext, useContext } from "react";

// Whether anything on screen is allowed to move. A context for the same
// reason the glyph table is one: it is decided once, from argv and the
// terminal, and every animated view needs it.
//
// Off means off completely — no clock is subscribed to, so a piped session,
// `--ascii` on a serial console, or an operator who set ORCH_NO_ANIM pays
// nothing for the animation at all.
const MotionContext = createContext(true);

export function MotionProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <MotionContext.Provider value={enabled}>{children}</MotionContext.Provider>;
}

export function useMotion(): boolean {
  return useContext(MotionContext);
}

/** `ORCH_NO_ANIM=1` is the operator's override, in the shape ORCH_ASCII set. */
export function motionEnabled(env: { ORCH_NO_ANIM?: string | undefined }, ascii: boolean, tty: boolean): boolean {
  if ((env.ORCH_NO_ANIM ?? "").trim() !== "") return false;
  return !ascii && tty;
}
