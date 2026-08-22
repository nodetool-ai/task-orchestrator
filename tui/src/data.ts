// Fake data for the mockup. Shapes mirror the real domain loosely:
// runs form a forest (parentId), a run has a persona, a status, an optional
// task/PR, cost, and a transcript. The inbox is what needs a human.

export type Status =
  | "running"
  | "preparing"
  | "queued"
  | "parked" // waiting on a question / event
  | "idle" // chat that is not currently working
  | "done"
  | "failed";

export type Run = {
  id: number;
  parentId: number | null;
  persona: string;
  title: string;
  status: Status;
  taskId?: string;
  pr?: { number: number; ci: "pending" | "pass" | "fail" };
  startedMin: number; // minutes ago
  cost: number;
  question?: string; // set when status === "parked"
};

export type Msg =
  | { kind: "user"; text: string; to?: number }
  | { kind: "agent"; run: number; text: string }
  | { kind: "tool"; run: number; text: string; detail?: string[] }
  | { kind: "spawn"; run: number; children: number[] }
  | { kind: "event"; run: number; text: string; tone?: "info" | "warn" | "ok" }
  | { kind: "question"; run: number; text: string; answered?: string };

export const runs: Run[] = [
  { id: 42, parentId: null, persona: "concierge", title: "ship the CLI plan", status: "running", startedMin: 12, cost: 1.2 },
  { id: 43, parentId: 42, persona: "executor", title: "P-cli · execute plan", status: "running", startedMin: 9, cost: 0.31 },
  { id: 44, parentId: 43, persona: "implementor", title: "T-0005 CLI shares the repo layer", status: "running", taskId: "T-0005", pr: { number: 312, ci: "pending" }, startedMin: 4, cost: 0.42 },
  { id: 45, parentId: 43, persona: "implementor", title: "T-0006 chat + runs subcommands", status: "parked", taskId: "T-0006", startedMin: 2, cost: 0.11, question: "Default backend for the new chat command — pi or claude? The repo env uses pi; AGENTS.md says claude." },
  { id: 46, parentId: 43, persona: "qa", title: "T-0007 end-to-end against acceptance criteria", status: "queued", taskId: "T-0007", startedMin: 0, cost: 0 },
  { id: 40, parentId: null, persona: "planner", title: "discord personas spec", status: "running", startedMin: 31, cost: 1.37 },
  { id: 41, parentId: 40, persona: "designer", title: "overlay + setup wizard mockups", status: "done", startedMin: 18, cost: 0.52 },
  { id: 38, parentId: null, persona: "concierge", title: "yesterday: why did run 27 fail?", status: "idle", startedMin: 1440, cost: 0.09 },
  { id: 37, parentId: null, persona: "implementor", title: "T-0003 REST API under app/api", status: "done", taskId: "T-0003", pr: { number: 301, ci: "pass" }, startedMin: 1500, cost: 0.88 },
  { id: 36, parentId: null, persona: "implementor", title: "T-0002 repo layer with transitions", status: "failed", taskId: "T-0002", startedMin: 1700, cost: 0.3 },
];

export const transcripts: Record<number, Msg[]> = {
  42: [
    { kind: "user", text: "ship the CLI plan" },
    { kind: "agent", run: 42, text: "Reading P-cli. Five tasks, three still open. I will hand the plan to an executor and report back when a PR is ready for you." },
    { kind: "tool", run: 42, text: "get_plan P-cli", detail: ["state accepted · 5 tasks · 2 merged, 3 todo"] },
    { kind: "spawn", run: 42, children: [43] },
    { kind: "event", run: 42, text: "#44 opened PR #312 · CI running", tone: "info" },
    { kind: "question", run: 45, text: "Default backend for the new chat command — pi or claude? The repo env uses pi; AGENTS.md says claude." },
  ],
  40: [
    { kind: "user", text: "write the spec for discord persona bots" },
    { kind: "agent", run: 40, text: "Drafting. I interviewed the existing settings code and the Discord webhook route. Spawning a designer for the setup flow." },
    { kind: "spawn", run: 40, children: [41] },
    { kind: "tool", run: 40, text: "write docs/superpowers/specs/discord-personas.md", detail: ["+412 lines"] },
    { kind: "agent", run: 40, text: "Spec is at docs/superpowers/specs/discord-personas.md. Open points: token storage and per-guild rate limits. Want me to turn it into tasks?" },
  ],
  38: [
    { kind: "user", text: "why did run 27 fail?" },
    { kind: "agent", run: 38, text: "Run 27 used the control-plane localPath as cwd on the box worker. The SDK error about libc is a red herring. It is recorded in docs/agent-caveats.md." },
  ],
  44: [
    { kind: "tool", run: 44, text: "read cli.ts", detail: ["946 lines"] },
    { kind: "tool", run: 44, text: "edit cli.ts", detail: ["+88 −12"] },
    { kind: "tool", run: 44, text: "npm test -- cli", detail: ["42 passed"] },
    { kind: "event", run: 44, text: "pushed claude/T-0005 · opened PR #312", tone: "ok" },
    { kind: "agent", run: 44, text: "PR #312 is open. Waiting for CI." },
  ],
  45: [
    { kind: "tool", run: 45, text: "read AGENTS.md", detail: ["2 backends documented"] },
    { kind: "question", run: 45, text: "Default backend for the new chat command — pi or claude? The repo env uses pi; AGENTS.md says claude." },
  ],
};

export type InboxItem = {
  id: string;
  run: number;
  kind: "question" | "review" | "stuck" | "budget";
  text: string;
  ageMin: number;
};

export const inbox: InboxItem[] = [
  { id: "q45", run: 45, kind: "question", text: "Default backend — pi or claude?", ageMin: 2 },
  { id: "pr312", run: 44, kind: "review", text: "PR #312 ready · CI pending", ageMin: 1 },
  { id: "f36", run: 36, kind: "stuck", text: "T-0002 failed: merge conflict in lib/repo.ts", ageMin: 1700 },
];

export const personas = ["concierge", "planner", "executor", "implementor", "designer", "qa"];

export const palette = [
  ...runs.map((r) => ({ kind: "run" as const, id: `#${r.id}`, label: `${r.persona} · ${r.title}` })),
  { kind: "task" as const, id: "T-0005", label: "CLI shares the repo layer" },
  { kind: "task" as const, id: "T-0006", label: "chat + runs subcommands" },
  { kind: "task" as const, id: "T-0007", label: "end-to-end against acceptance criteria" },
  { kind: "plan" as const, id: "P-cli", label: "Task orchestrator CLI" },
  { kind: "plan" as const, id: "P-discord", label: "Discord persona bots" },
];

export function childrenOf(id: number): Run[] {
  return runs.filter((r) => r.parentId === id);
}
export function byId(id: number): Run {
  return runs.find((r) => r.id === id)!;
}
export function roots(): Run[] {
  return runs.filter((r) => r.parentId === null);
}
export function subtreeCost(id: number): number {
  return byId(id).cost + childrenOf(id).reduce((s, c) => s + subtreeCost(c.id), 0);
}
export function liveCount(): number {
  return runs.filter((r) => r.status === "running" || r.status === "preparing").length;
}
