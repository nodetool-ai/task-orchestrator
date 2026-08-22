// The live data store: one place that owns every subscription, timer and
// fetch the cockpit needs, and one immutable snapshot the views render from.
//
// It is deliberately headless — no React — because the interesting bugs here
// (a leaked run subscription, a cache that never expires, work scheduled after
// exit) are invisible through a renderer and trivial to assert directly.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { UnauthorizedError, type OrchClient, type Subscription } from "./api/client.js";
import { ZERO_CURSOR, type PlanSummary, type RunIndexRow, type StreamCursor, type TaskSummary } from "./api/types.js";
import { buildForest, type Forest } from "./model/forest.js";
import { appendFrame, frameFromEvent, framesFromMessages, type Frame } from "./model/frames.js";
import { toInboxItems, type InboxItem } from "./model/inbox.js";
import { buildPalette, type PaletteItem } from "./model/palette.js";

export type ConnStatus = "connecting" | "live" | "reconnecting" | "offline" | "unauthorized";

export interface OrchState {
  forest: Forest;
  inbox: InboxItem[];
  /** Transcript of `current`, batch load folded together with the live stream. */
  frames: Frame[];
  current: number | null;
  palette: PaletteItem[];
  status: ConnStatus;
  /** One line the operator can act on; never a stack trace. */
  error: string | null;
  now: number;
  /** The current run's batch load is in flight (first paint of a switch). */
  loading: boolean;
}

export interface StoreActions {
  /** Switch the transcript. Tears the previous run's stream down first. */
  select(id: number | null): void;
  /** Called when the palette opens: refreshes tasks/plans if the cache is cold. */
  ensurePalette(): void;
  refreshInbox(): void;
  /** The run attached to a task id, if the overview already knows one. */
  runForTask(taskId: string): number | null;
}

export interface Store {
  getState(): OrchState;
  subscribe(fn: () => void): () => void;
  readonly actions: StoreActions;
  /** Idempotent. After this nothing is scheduled and no handler fires. */
  stop(): void;
}

/** Injected so tests drive time instead of sleeping. */
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface StoreOptions {
  clock?: Clock;
  /** Ages tick, nothing else. Slow on purpose (PRD §7: idle CPU near zero). */
  tickMs?: number;
  /** Backstop poll for the needs-you list; the overview drives the real refresh. */
  inboxMs?: number;
  /** Floor after an inbox refresh, so a burst of overview frames cannot hammer it. */
  inboxGapMs?: number;
  /** Overview poll used only after the stream said `_eos`. */
  pollMs?: number;
  /** T-tui-05: tasks/plans are cached this long. */
  cacheMs?: number;
  /** Run to open at startup; otherwise the newest root once the overview lands. */
  current?: number | null;
  /** Off for tests that want to control selection by hand. */
  autoSelect?: boolean;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const EMPTY_FOREST = buildForest([]);

export const POLLING_NOTE = "no live stream · polling";

export function createStore(client: OrchClient, opts: StoreOptions = {}): Store {
  const clock = opts.clock ?? realClock;
  const tickMs = opts.tickMs ?? 2000;
  const inboxMs = opts.inboxMs ?? 30_000;
  const inboxGapMs = opts.inboxGapMs ?? 1000;
  const pollMs = opts.pollMs ?? 5000;
  const cacheMs = opts.cacheMs ?? 30_000;
  const autoSelect = opts.autoSelect ?? true;

  let state: OrchState = {
    forest: EMPTY_FOREST,
    inbox: [],
    frames: [],
    current: opts.current ?? null,
    palette: [],
    status: "connecting",
    error: null,
    now: clock.now(),
    loading: false,
  };

  const listeners = new Set<() => void>();
  let stopped = false;

  // Named handles: re-arming a timer always replaces the previous one, so a
  // burst of triggers cannot leave two copies of the same timer running.
  const timers = new Map<string, unknown>();
  function arm(name: string, ms: number, fn: () => void): void {
    if (stopped) return;
    disarm(name);
    timers.set(
      name,
      clock.setTimer(() => {
        timers.delete(name);
        if (!stopped) fn();
      }, ms),
    );
  }
  function disarm(name: string): void {
    const h = timers.get(name);
    if (h === undefined) return;
    timers.delete(name);
    clock.clearTimer(h);
  }

  function set(patch: Partial<OrchState>): void {
    if (stopped) return;
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  }

  // ── errors ───────────────────────────────────────────────────────────────
  // Any 401 is terminal: retrying cannot fix it, and the operator needs the
  // one-line remedy rather than a stack.
  function fail(err: unknown, fallback: ConnStatus = "offline"): void {
    if (stopped) return;
    if (err instanceof UnauthorizedError) {
      set({ status: "unauthorized", error: err.hint });
      return;
    }
    if (state.status === "unauthorized") return;
    set({ status: fallback, error: message(err) });
  }

  // ── overview ─────────────────────────────────────────────────────────────
  let overviewSub: Subscription | null = null;
  let polling = false;
  // null until the first snapshot: the boot-time inbox fetch already covers
  // it, so the first overview must not queue a second one.
  let rowsSig: string | null = null;

  function applyRows(rows: RunIndexRow[]): void {
    if (stopped) return;
    const forest = buildForest(rows);
    const patch: Partial<OrchState> = { forest, palette: paletteFrom(forest) };
    // A 401 stays on screen: rows arriving from a cached poll do not clear it.
    if (state.status !== "unauthorized") {
      // Polling still delivers rows, so this is "live" with a caveat, not
      // offline — but the caveat has to be visible somewhere.
      patch.status = "live";
      patch.error = polling ? POLLING_NOTE : null;
    }
    // Auto-open the newest root so the cockpit paints a conversation rather
    // than an empty pane on first launch.
    let select: number | null = null;
    if (autoSelect && state.current === null) {
      const first = forest.roots()[0] ?? forest.runs[0];
      if (first) select = first.id;
    }
    set(patch);
    if (select !== null) actions.select(select);

    // Pending counts move with run state, so the needs-you list is stale the
    // moment the overview changes — but only then.
    const sig = rows.map((r) => `${r.id}:${r.status}:${r.pendingEvents}:${r.parkReason ?? ""}`).join("|");
    if (sig !== rowsSig) {
      const first = rowsSig === null;
      rowsSig = sig;
      if (!first) refreshInbox();
    }
  }

  async function fetchOverview(): Promise<void> {
    try {
      applyRows(await client.overview());
    } catch (err) {
      fail(err);
    }
  }

  function pollOverview(): void {
    polling = true;
    void fetchOverview().finally(() => {
      if (!stopped && polling) arm("poll", pollMs, pollOverview);
    });
  }

  function startOverview(): void {
    overviewSub = client.overviewEvents({
      onRows: (rows) => applyRows(rows),
      onEnd: () => {
        // `_eos` means the server told us to stop reconnecting (it is serving
        // an unauthenticated stream). The client will not come back on its
        // own, so the cockpit degrades to a poll rather than freezing.
        if (stopped) return;
        overviewSub = null;
        if (!polling) pollOverview();
      },
      onError: (err) => fail(err),
      onReconnect: (attempt, delayMs) => {
        if (stopped || state.status === "unauthorized") return;
        set({ status: "reconnecting", error: `reconnecting in ${Math.round(delayMs / 1000)}s (try ${attempt})` });
      },
    });
  }

  // ── inbox ────────────────────────────────────────────────────────────────
  let inboxInFlight = false;
  let inboxDirty = false;
  let inboxAt = -Infinity;

  function refreshInbox(): void {
    if (stopped || state.status === "unauthorized") return;
    if (inboxInFlight) {
      inboxDirty = true;
      return;
    }
    const since = clock.now() - inboxAt;
    if (since < inboxGapMs) {
      arm("inbox-soon", inboxGapMs - since, refreshInbox);
      return;
    }
    inboxInFlight = true;
    inboxAt = clock.now();
    client
      .inbox()
      .then((rows) => {
        if (!stopped) set({ inbox: toInboxItems(rows) });
      })
      .catch((err) => fail(err))
      .finally(() => {
        inboxInFlight = false;
        if (inboxDirty && !stopped) {
          inboxDirty = false;
          arm("inbox-soon", inboxGapMs, refreshInbox);
        }
      });
    arm("inbox", inboxMs, refreshInbox); // backstop, not the primary path
  }

  // ── palette catalog (T-tui-05: cached 30 s) ──────────────────────────────
  let tasks: TaskSummary[] = [];
  let plans: PlanSummary[] = [];
  let catalogAt = -Infinity;
  let catalogInFlight = false;

  function paletteFrom(forest: Forest): PaletteItem[] {
    return buildPalette(forest.runs, tasks, plans);
  }

  /** Never blocks the palette: the runs are already there, the rest fills in. */
  function ensurePalette(): void {
    if (stopped || catalogInFlight) return;
    if (clock.now() - catalogAt < cacheMs) return;
    catalogInFlight = true;
    catalogAt = clock.now();
    Promise.all([client.tasks(), client.plans()])
      .then(([t, p]) => {
        if (stopped) return;
        tasks = t;
        plans = p;
        set({ palette: paletteFrom(state.forest) });
      })
      .catch((err) => {
        // A cold catalog must not empty the palette; keep what we have and
        // let the next open retry.
        catalogAt = -Infinity;
        fail(err, state.status === "connecting" ? "offline" : state.status);
      })
      .finally(() => {
        catalogInFlight = false;
      });
  }

  // ── current run ──────────────────────────────────────────────────────────
  let runSub: Subscription | null = null;
  // Bumped on every switch. Every async continuation and every stream handler
  // checks it, so a frame that is already in flight when the user moves on is
  // dropped rather than landing in the wrong transcript.
  let gen = 0;

  function closeRun(): void {
    gen++;
    runSub?.close();
    runSub = null;
  }

  function select(id: number | null): void {
    if (stopped || id === state.current) return;
    closeRun();
    const mine = gen;
    set({ current: id, frames: [], loading: id !== null });
    if (id === null) return;

    void client
      .run(id)
      .then((detail) => {
        if (stopped || gen !== mine) return;
        const frames = framesFromMessages(detail.messages ?? []);
        set({ frames, loading: false });
        // Resume the stream past the messages we already have; events are not
        // in the batch, so their cursor stays at zero.
        const msgId = (detail.messages ?? []).reduce((m, r) => Math.max(m, r.id), 0);
        openRunStream(id, { msgId, evtId: ZERO_CURSOR.evtId }, mine);
      })
      .catch((err) => {
        if (stopped || gen !== mine) return;
        set({ loading: false });
        fail(err);
        // The batch failed but the stream may still work (and reconnects).
        openRunStream(id, ZERO_CURSOR, mine);
      });
  }

  function openRunStream(id: number, cursor: StreamCursor, mine: number): void {
    if (stopped || gen !== mine) return;
    const sub = client.runEvents(id, cursor, {
      onMessage: (m) => {
        if (gen !== mine) return;
        for (const f of framesFromMessages([m])) push(f);
      },
      onEvent: (frame) => {
        if (gen !== mine) return;
        const f = frameFromEvent(id, frame);
        if (f) push(f);
      },
      onError: (err) => {
        if (gen !== mine) return;
        fail(err);
      },
      onReconnect: () => {
        if (gen !== mine || state.status === "unauthorized" || state.status === "offline") return;
        set({ status: "reconnecting" });
      },
    });
    // A switch that happened while `run()` was in flight already bumped gen;
    // close immediately so the subscription cannot outlive its run.
    if (stopped || gen !== mine) {
      sub.close();
      return;
    }
    runSub = sub;
  }

  function push(f: Frame): void {
    const frames = appendFrame(state.frames, f);
    if (frames !== state.frames) set({ frames });
  }

  // ── clock ────────────────────────────────────────────────────────────────
  function tick(): void {
    set({ now: clock.now() });
    arm("tick", tickMs, tick);
  }

  const actions: StoreActions = {
    select,
    ensurePalette,
    refreshInbox,
    runForTask(taskId) {
      // Resolved from the forest rather than GET /api/tasks/:id/attached-run:
      // the overview already carries taskId on every run, so this is one map
      // lookup instead of a round trip. Newest run wins when a task was retried.
      let best: number | null = null;
      for (const r of state.forest.runs) {
        if (r.taskId !== taskId) continue;
        if (best === null || r.id > best) best = r.id;
      }
      return best;
    },
  };

  const store: Store = {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actions,
    stop() {
      if (stopped) return;
      stopped = true;
      closeRun();
      overviewSub?.close();
      overviewSub = null;
      polling = false;
      for (const h of timers.values()) clock.clearTimer(h);
      timers.clear();
      listeners.clear();
    },
  };

  // Start: cached-free first paint from REST, then live.
  void fetchOverview();
  startOverview();
  refreshInbox();
  ensurePalette();
  arm("tick", tickMs, tick);
  if (state.current !== null) {
    const want = state.current;
    state = { ...state, current: null };
    select(want);
  }

  return store;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── React binding ──────────────────────────────────────────────────────────

export function useOrch(client: OrchClient, opts: StoreOptions = {}): OrchState & { actions: StoreActions } {
  // The store owns every subscription, so it must be created once per client
  // and torn down with the component — never rebuilt on a render.
  const store = useMemo(() => createStore(client, opts), [client]);
  useEffect(() => () => store.stop(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { ...state, actions: store.actions };
}
