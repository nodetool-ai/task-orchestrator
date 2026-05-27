"use client";

import * as React from "react";

type OverlayState = {
  palette: boolean;
  spawn: boolean;
};

type Listener = (s: OverlayState) => void;

let state: OverlayState = { palette: false, spawn: false };
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(state);
}

export function setOverlay(patch: Partial<OverlayState>) {
  state = { ...state, ...patch };
  emit();
}

export function openPalette() { setOverlay({ palette: true }); }
export function closePalette() { setOverlay({ palette: false }); }
export function openSpawn() { setOverlay({ spawn: true }); }
export function closeSpawn() { setOverlay({ spawn: false }); }

export function useOverlay(): OverlayState {
  const [s, set] = React.useState(state);
  React.useEffect(() => {
    listeners.add(set);
    return () => { listeners.delete(set); };
  }, []);
  return s;
}
