// Fake server fixtures for `npm run mock`: the same design story the mockup
// has always told (the CLI plan, PR #312, the parked backend question), but
// shaped exactly like the wire types so the mock exercises the real client
// interface, the real model layer and the real store. If a payload shape here
// stops compiling, the cockpit would have broken against the server too.

import type { OrchClient, OverviewHandlers, RunEventHandlers, Subscription } from "./api/client.js";
import type {
  CreateRunInput,
  GlobalInboxRow,
  MessageRow,
  PersonaSummary,
  PlanSummary,
  RunDetail,
  RunIndexRow,
  RunInbox,
  RunRow,
  SdkContentBlock,
  TaskSummary,
} from "./api/types.js";

// Fixtures are written in minutes-ago so the mockup's ages read the same on
// every launch.
const BOOT = Date.now();
const ago = (min: number): string => new Date(BOOT - min * 60_000).toISOString();

const PLAN_TITLES_SRC: Array<[string, string]> = [
  ["P-cli", "Task orchestrator CLI"],
  ["P-discord", "Discord persona bots"],
  ["P-api", "REST API and repo layer"],
];
const PLAN_TITLES: Record<string, string> = Object.fromEntries(PLAN_TITLES_SRC);

/** The one question the mockup parks on, quoted in three places. */
const QUESTION =
  "Default backend for the new chat command — pi or claude? The repo env uses pi; AGENTS.md says claude.";

interface RowSeed {
  id: number;
  parent: number | null;
  persona: string;
  title: string;
  status: RunIndexRow["status"];
  parkReason?: string;
  taskId?: string;
  planId?: string;
  pr?: number;
  startedMin: number;
  doneMin?: number;
  cost: number;
  pending?: number;
  error?: string;
}

const SEEDS: RowSeed[] = [
  { id: 42, parent: null, persona: "concierge", title: "ship the CLI plan", status: "running", planId: "P-cli", startedMin: 12, cost: 1.2 },
  { id: 43, parent: 42, persona: "executor", title: "P-cli · execute plan", status: "running", planId: "P-cli", startedMin: 9, cost: 0.31 },
  { id: 44, parent: 43, persona: "implementor", title: "T-0005 CLI shares the repo layer", status: "running", taskId: "T-0005", planId: "P-cli", pr: 312, startedMin: 4, cost: 0.42, pending: 1 },
  {
    id: 45,
    parent: 43,
    persona: "implementor",
    title: "T-0006 chat + runs subcommands",
    status: "parked",
    parkReason: "question",
    taskId: "T-0006",
    planId: "P-cli",
    startedMin: 2,
    cost: 0.11,
    pending: 1,
  },
  { id: 46, parent: 43, persona: "qa", title: "T-0007 end-to-end against acceptance criteria", status: "pending", taskId: "T-0007", planId: "P-cli", startedMin: 0, cost: 0 },
  { id: 40, parent: null, persona: "planner", title: "discord personas spec", status: "running", planId: "P-discord", startedMin: 31, cost: 1.37 },
  { id: 41, parent: 40, persona: "designer", title: "overlay + setup wizard mockups", status: "completed", planId: "P-discord", startedMin: 18, doneMin: 6, cost: 0.52 },
  { id: 38, parent: null, persona: "concierge", title: "yesterday: why did run 27 fail?", status: "idle", startedMin: 1440, cost: 0.09 },
  { id: 37, parent: null, persona: "implementor", title: "T-0003 REST API under app/api", status: "completed", taskId: "T-0003", planId: "P-api", pr: 301, startedMin: 1500, doneMin: 1460, cost: 0.88 },
  {
    id: 36,
    parent: null,
    persona: "implementor",
    title: "T-0002 repo layer with transitions",
    status: "failed",
    taskId: "T-0002",
    planId: "P-api",
    startedMin: 1700,
    doneMin: 1690,
    cost: 0.3,
    error: "merge conflict in lib/repo.ts",
    pending: 1,
  },
];

const PERSONA_NAMES: Record<string, string> = {
  concierge: "concierge",
  planner: "planner",
  executor: "executor",
  implementor: "implementor",
  designer: "designer",
  qa: "qa",
};

export const runIndexRows: RunIndexRow[] = SEEDS.map((s) => ({
  id: s.id,
  goal: s.title,
  status: s.status,
  origin: s.taskId ? "task" : "chat",
  title: s.title,
  taskId: s.taskId ?? null,
  taskTitle: s.taskId ? s.title.replace(/^T-\d+\s+/, "") : null,
  planId: s.planId ?? null,
  planTitle: s.planId ? (PLAN_TITLES[s.planId] ?? null) : null,
  repoId: "repo-orch",
  repoName: "task-orchestrator",
  parentRunId: s.parent,
  prUrl: s.pr ? `https://github.com/acme/task-orchestrator/pull/${s.pr}` : null,
  model: "claude-opus-5",
  budgetMaxUsd: null,
  budgetMaxTurns: null,
  totalCostUsd: s.cost,
  error: s.error ?? null,
  startedAt: ago(s.startedMin),
  completedAt: s.doneMin === undefined ? null : ago(s.doneMin),
  parkReason: s.parkReason ?? null,
  pendingReason: s.parkReason === "question" ? "question" : null,
  pendingEvents: s.pending ?? 0,
  personaId: s.persona,
  personaName: PERSONA_NAMES[s.persona] ?? s.persona,
}));

// ── transcripts ────────────────────────────────────────────────────────────

const text = (s: string): SdkContentBlock => ({ type: "text", text: s });
const thinking = (s: string): SdkContentBlock => ({ type: "thinking", thinking: s });
const tool = (id: string, name: string, input: unknown): SdkContentBlock => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string): SdkContentBlock => ({ type: "tool_result", tool_use_id: id, content });

let nextMessageId = 1000;
function msg(runId: number, role: MessageRow["role"], min: number, content: SdkContentBlock[]): MessageRow {
  return { id: nextMessageId++, runId, role, content, createdAt: ago(min) };
}

export const messageRows: MessageRow[] = [
  // #42 concierge — the top-level conversation the cockpit opens on.
  msg(42, "user", 12, [text("ship the CLI plan")]),
  msg(42, "agent", 12, [
    thinking(
      "The plan has five tasks and three are open. Handing the whole plan to one executor keeps the ordering constraints in one place, rather than racing three implementors against each other on the same repo layer.",
    ),
  ]),
  msg(42, "agent", 12, [
    text(
      "Reading P-cli. Five tasks, three still open. I will hand the plan to an executor and report back when a PR is ready for you.",
    ),
  ]),
  msg(42, "agent", 11, [tool("t1", "task_orch__get_plan", { plan_id: "P-cli" })]),
  msg(42, "tool", 11, [result("t1", "state accepted · 5 tasks · 2 merged, 3 todo")]),
  msg(42, "agent", 10, [tool("t2", "start_session", { persona: "executor", goal: "execute P-cli" })]),
  msg(42, "tool", 10, [result("t2", "Started session #43 on P-cli (model: default).")]),
  msg(42, "system", 4, [
    { type: "inbox_event", ...({ event_type: "gh.pr.opened", payload: { run_id: 44, number: 312 } } as Record<string, unknown>) } as SdkContentBlock,
  ]),

  // A call with no result yet: the design surface has to show the dot that
  // is still blinking, not only the ones that came back.
  msg(42, "agent", 1, [tool("t9", "grep", { pattern: "TODO\\(cli\\)" })]),

  // #40 planner — the second root, so the floor has two trees.
  msg(40, "user", 31, [text("write the spec for discord persona bots")]),
  msg(40, "agent", 30, [
    text(
      "Drafting. I interviewed the existing settings code and the Discord webhook route. Spawning a designer for the setup flow.",
    ),
  ]),
  msg(40, "agent", 29, [tool("t3", "start_session", { persona: "designer", goal: "overlay + setup wizard mockups" })]),
  msg(40, "tool", 29, [result("t3", "Started session #41 on P-discord (model: default).")]),
  msg(40, "agent", 20, [tool("t4", "write", { file_path: "docs/superpowers/specs/discord-personas.md" })]),
  msg(40, "tool", 20, [result("t4", "+412 lines")]),
  msg(40, "agent", 19, [
    text(
      "Spec is at docs/superpowers/specs/discord-personas.md. Open points: token storage and per-guild rate limits. Want me to turn it into tasks?",
    ),
  ]),

  // #38 — an idle chat you can scroll back to.
  msg(38, "user", 1440, [text("why did run 27 fail?")]),
  msg(38, "agent", 1439, [
    text(
      "Run 27 used the control-plane localPath as cwd on the box worker. The SDK error about libc is a red herring. It is recorded in docs/agent-caveats.md.",
    ),
  ]),

  // #44 — the PR #312 story.
  msg(44, "agent", 4, [tool("t5", "read", { file_path: "cli.ts" })]),
  msg(44, "tool", 4, [result("t5", "946 lines")]),
  msg(44, "agent", 3, [tool("t6", "edit", { file_path: "cli.ts" })]),
  msg(44, "tool", 3, [result("t6", "+88 −12")]),
  msg(44, "agent", 2, [tool("t7", "bash", { command: "npm test -- cli" })]),
  msg(44, "tool", 2, [
    { type: "tool_result", tool_use_id: "t7", content: "42 passed\n3 skipped\n1 flaky: cli tails a closed run\nsuite green in 8.2s" },
  ]),
  msg(44, "agent", 1, [text("PR #312 is open. Waiting for CI.")]),

  // #45 — the parked question.
  msg(45, "agent", 2, [tool("t8", "read", { file_path: "AGENTS.md" })]),
  msg(45, "tool", 2, [result("t8", "2 backends documented")]),
];

/** The live frames each run's stream replays once on connect. */
const RUN_EVENTS: Record<number, Array<Record<string, unknown> & { type: string }>> = {
  42: [{ type: "child.question", run_id: 45, question: QUESTION, at: ago(2) }],
  44: [
    { type: "gh.pr.opened", number: 312, url: "https://github.com/acme/task-orchestrator/pull/312", at: ago(4) },
    { type: "gh.ci.completed", conclusion: "pending", at: ago(1) },
  ],
  45: [{ type: "run.question", question: QUESTION, at: ago(2) }],
};

// ── inbox, tasks, plans ────────────────────────────────────────────────────

export const globalInboxRows: GlobalInboxRow[] = [
  {
    id: "q45",
    runId: 45,
    personaId: "implementor",
    personaName: "implementor",
    runTitle: "T-0006 chat + runs subcommands",
    kind: "question",
    type: "run.question",
    text: "Default backend — pi or claude?",
    prUrl: null,
    createdAt: ago(2),
  },
  {
    id: "e312",
    runId: 44,
    personaId: "implementor",
    personaName: "implementor",
    runTitle: "T-0005 CLI shares the repo layer",
    kind: "review",
    type: "gh.pr.opened",
    text: "PR #312 ready · CI pending",
    prUrl: "https://github.com/acme/task-orchestrator/pull/312",
    createdAt: ago(1),
  },
  {
    id: "e36",
    runId: 36,
    personaId: "implementor",
    personaName: "implementor",
    runTitle: "T-0002 repo layer with transitions",
    kind: "stuck",
    type: "run.failed",
    text: "T-0002 failed: merge conflict in lib/repo.ts",
    prUrl: null,
    createdAt: ago(1700),
  },
];

export const planSummaries: PlanSummary[] = PLAN_TITLES_SRC.map(([id, title], i) => ({
  id,
  title,
  state: i === 2 ? "done" : "accepted",
}));

export const taskSummaries: TaskSummary[] = [
  { id: "T-0002", title: "repo layer with transitions", state: "failed", planId: "P-api", prUrl: null },
  { id: "T-0003", title: "REST API under app/api", state: "merged", planId: "P-api", prUrl: "https://github.com/acme/task-orchestrator/pull/301" },
  { id: "T-0005", title: "CLI shares the repo layer", state: "in_progress", planId: "P-cli", prUrl: "https://github.com/acme/task-orchestrator/pull/312" },
  { id: "T-0006", title: "chat + runs subcommands", state: "in_progress", planId: "P-cli", prUrl: null },
  { id: "T-0007", title: "end-to-end against acceptance criteria", state: "todo", planId: "P-cli", prUrl: null },
  // No run has ever touched this one: `↵` on it shows the id in the status
  // line rather than opening a chat (T-tui-05).
  { id: "T-0009", title: "packaging: npx orch", state: "todo", planId: "P-cli", prUrl: null },
];

export const personas = ["concierge", "planner", "executor", "implementor", "designer", "qa"];

/** GET /api/personas, with the budgets `/new` reads off the persona. */
export const personaSummaries: PersonaSummary[] = personas.map((id) => ({
  id,
  name: PERSONA_NAMES[id] ?? id,
  description: `the ${id} persona`,
  modelProvider: "anthropic",
  modelId: "claude-opus-5",
  thinkingLevel: id === "planner" ? "high" : "medium",
  toolsProfile: "default",
  backend: "claude",
  budgetMaxTurns: 40,
  budgetMaxSeconds: 1800,
}));

// ── the fake client ────────────────────────────────────────────────────────

/**
 * A complete `OrchClient` served from the fixtures above. The subscriptions
 * are real objects with a working `close()`: the mock is also how the store's
 * teardown gets exercised by hand.
 */
export function createFakeClient(): OrchClient {
  const rows = runIndexRows;
  let nextRunId = Math.max(...rows.map((r) => r.id)) + 1;

  const toRunRow = (row: RunIndexRow): RunRow => ({
    id: row.id,
    goal: row.goal,
    status: row.status,
    title: row.title,
    personaId: row.personaId,
    parentRunId: row.parentRunId,
    model: row.model,
    budgetMaxUsd: row.budgetMaxUsd,
    budgetMaxTurns: row.budgetMaxTurns,
    taskId: row.taskId,
    planId: row.planId,
    prUrl: row.prUrl,
    totalCostUsd: row.totalCostUsd,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });

  const detail = (id: number): RunDetail => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no run ${id}`);
    return {
      id: row.id,
      goal: row.goal,
      status: row.status,
      title: row.title,
      taskId: row.taskId,
      planId: row.planId,
      parentRunId: row.parentRunId,
      personaId: row.personaId,
      prUrl: row.prUrl,
      model: row.model,
      totalCostUsd: row.totalCostUsd,
      error: row.error,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      parkReason: row.parkReason,
      budgetMaxUsd: row.budgetMaxUsd,
      budgetMaxTurns: row.budgetMaxTurns,
      messages: messageRows.filter((m) => m.runId === id),
      live: row.status === "running" || row.status === "preparing",
    };
  };

  // A snapshot then silence, which is exactly what a quiet server looks like.
  const later = (fn: () => void): { cancel(): void } => {
    const h = setTimeout(fn, 0);
    if (typeof h === "object" && h && "unref" in h) (h as { unref(): void }).unref();
    return { cancel: () => clearTimeout(h) };
  };

  return {
    overview: async () => rows,
    listRuns: async () => rows,
    run: async (id) => detail(id),
    runInbox: async (): Promise<RunInbox> => ({ events: [], timers: [] }),
    inbox: async () => globalInboxRows,
    tasks: async () => taskSummaries,
    plans: async () => planSummaries,

    personas: async () => personaSummaries,

    // The mock has no agent behind it, so a sent message just lands in the
    // transcript the way the server's own `user_message` frame would.
    sendMessage: async (id, text) => {
      messageRows.push(msg(id, "user", 0, [{ type: "text", text }]));
    },

    createRun: async (input: CreateRunInput): Promise<RunRow> => {
      const id = nextRunId++;
      const row: RunIndexRow = {
        ...runIndexRows[0]!,
        id,
        goal: input.goal,
        status: "running",
        origin: input.taskId ? "task" : "chat",
        title: input.title ?? input.goal,
        taskId: input.taskId ?? null,
        taskTitle: null,
        planId: null,
        planTitle: null,
        parentRunId: null,
        prUrl: null,
        totalCostUsd: 0,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        parkReason: null,
        pendingReason: null,
        pendingEvents: 0,
        personaId: input.personaId ?? null,
        personaName: input.personaId ? (PERSONA_NAMES[input.personaId] ?? input.personaId) : null,
      };
      rows.unshift(row);
      return toRunRow(row);
    },

    configureRun: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no run ${id}`);
      if (patch.model !== undefined) row.model = patch.model;
      if (patch.budgetMaxUsd !== undefined) row.budgetMaxUsd = patch.budgetMaxUsd;
      if (patch.budgetMaxTurns !== undefined) row.budgetMaxTurns = patch.budgetMaxTurns;
      return toRunRow(row);
    },

    cancelRun: async (id) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no run ${id}`);
      row.status = "cancelled";
      row.completedAt = new Date().toISOString();
      // Cancel cascades on the server; mirror that so the floor looks right.
      for (const r of rows) {
        if (r.parentRunId === id && r.status !== "completed") r.status = "cancelled";
      }
      return toRunRow(row);
    },

    overviewEvents(h: OverviewHandlers): Subscription {
      let closed = false;
      const t = later(() => {
        if (!closed) h.onRows(rows);
      });
      return {
        close() {
          closed = true;
          t.cancel();
        },
      };
    },

    runEvents(id, _cursor, h: RunEventHandlers): Subscription {
      let closed = false;
      const t = later(() => {
        if (closed) return;
        for (const e of RUN_EVENTS[id] ?? []) h.onEvent(e);
      });
      return {
        close() {
          closed = true;
          t.cancel();
        },
      };
    },
  };
}
