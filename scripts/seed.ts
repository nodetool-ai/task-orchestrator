// Seed the required personas, plus an optional populated local demo workspace.
//
// `npm run db:seed` is intentionally persona-only. `npm run db:seed:demo`
// adds deterministic plans, tasks, and run summaries that exercise the Floor,
// Plans, and Tasks screens. Every demo row has a stable id/marker, so rerunning
// the command fills in missing fixtures without duplicating existing ones.
//
// Load .env.local before any DB-touching module is imported. ESM static imports
// run before this module body, so those imports stay dynamic inside main().
import { config } from "dotenv";
config({ path: ".env.local" });

type DemoTaskState =
  | "todo"
  | "in_progress"
  | "testing"
  | "failing"
  | "passing"
  | "merged"
  | "blocked"
  | "cancelled";

type DemoTask = {
  id: string;
  planId: string;
  title: string;
  state: DemoTaskState;
  assignee: string | null;
  body: string;
  estimate: string;
  tags: string[];
  criteria: string[];
  criteriaDone: number;
  dependencies?: string[];
  note?: { author: string; body: string };
};

const DEMO_REPO_ID = "R-demo-atlas";

const demoPlans = [
  {
    id: "P-2026-09-07-release-command-center",
    title: "Release command center",
    state: "accepted" as const,
    owner: "Maya Chen",
    tags: ["product", "release", "observability"],
    body:
      "# Goal\n\nGive release managers one dependable view of deployment health, approvals, and rollback readiness before the autumn launch.\n\n# Success signals\n\n- Critical checks are visible without leaving the dashboard\n- Owners can spot blocked releases in under 30 seconds\n- Every production change has an explicit rollback path",
  },
  {
    id: "P-2026-09-07-guided-onboarding",
    title: "Guided customer onboarding",
    state: "proposed" as const,
    owner: "Noah Williams",
    tags: ["growth", "onboarding", "research"],
    body:
      "# Goal\n\nHelp new workspace owners reach their first successful automated run with less setup friction and clearer progress cues.\n\n# Scope\n\nInstrument the setup funnel, simplify repository connection, and validate the new checklist with design partners.",
  },
  {
    id: "P-2026-09-07-accessibility-refresh",
    title: "Accessibility refresh",
    state: "accepted" as const,
    finalState: "done" as const,
    owner: "Priya Shah",
    tags: ["frontend", "a11y", "quality"],
    body:
      "# Goal\n\nBring the primary planning workflow to WCAG 2.2 AA and make keyboard navigation feel intentional throughout the product.\n\n# Outcome\n\nCore flows now pass automated and manual accessibility checks.",
  },
  {
    id: "P-2026-09-07-agent-evaluation-lab",
    title: "Agent evaluation lab",
    state: "draft" as const,
    owner: "Elena Rossi",
    tags: ["agents", "evaluation", "platform"],
    body:
      "# Goal\n\nDefine a repeatable evaluation harness for comparing agent personas on realistic repository tasks before model or prompt changes ship.",
  },
];

const demoTasks: DemoTask[] = [
  {
    id: "T-20260907-9001",
    planId: demoPlans[0].id,
    title: "Stream deployment health into the release timeline",
    state: "in_progress",
    assignee: "implementor",
    estimate: "L",
    tags: ["backend", "realtime"],
    body: "Aggregate check suites and deployment events into a single ordered release timeline.",
    criteria: ["Deployment events update without refresh", "Failed checks identify their owning service", "Timeline remains readable with 100+ events"],
    criteriaDone: 1,
    note: { author: "Maya Chen", body: "Use the existing event stream; polling introduced too much lag in the prototype." },
  },
  {
    id: "T-20260907-9002",
    planId: demoPlans[0].id,
    title: "Add approval gates and rollback readiness",
    state: "passing",
    assignee: "qa",
    estimate: "M",
    tags: ["frontend", "release"],
    body: "Surface required approvals and the latest verified rollback artifact beside each release candidate.",
    criteria: ["Missing approvals are actionable", "Rollback artifact links are validated", "All required checks pass"],
    criteriaDone: 3,
    dependencies: ["T-20260907-9001"],
  },
  {
    id: "T-20260907-9003",
    planId: demoPlans[0].id,
    title: "Document the incident handoff playbook",
    state: "todo",
    assignee: "planner",
    estimate: "S",
    tags: ["docs", "operations"],
    body: "Write the short handoff used when a release issue crosses team or timezone boundaries.",
    criteria: ["Names the incident commander handoff fields", "Includes one realistic example"],
    criteriaDone: 0,
    dependencies: ["T-20260907-9002"],
  },
  {
    id: "T-20260907-9004",
    planId: demoPlans[0].id,
    title: "Resolve flaky canary verification",
    state: "blocked",
    assignee: "qa",
    estimate: "M",
    tags: ["ci", "blocked"],
    body: "Stabilize the canary smoke suite before it becomes a required production gate.",
    criteria: ["Reproduction captured", "Root cause confirmed", "Twenty consecutive canaries pass"],
    criteriaDone: 1,
    note: { author: "qa", body: "Blocked on intermittent telemetry gaps from the eu-west canary environment." },
  },
  {
    id: "T-20260907-9005",
    planId: demoPlans[1].id,
    title: "Prototype the first-run setup checklist",
    state: "testing",
    assignee: "designer",
    estimate: "M",
    tags: ["design", "onboarding"],
    body: "Turn the setup journey into a concise checklist with contextual recovery guidance.",
    criteria: ["Progress persists across sessions", "Each step has a recovery action", "Keyboard flow is complete"],
    criteriaDone: 2,
  },
  {
    id: "T-20260907-9006",
    planId: demoPlans[1].id,
    title: "Instrument activation funnel events",
    state: "in_progress",
    assignee: "implementor",
    estimate: "M",
    tags: ["analytics", "backend"],
    body: "Capture privacy-conscious events from workspace creation through the first successful run.",
    criteria: ["Event names follow the tracking plan", "No secrets or source content are captured", "Dashboard query is documented"],
    criteriaDone: 1,
  },
  {
    id: "T-20260907-9007",
    planId: demoPlans[1].id,
    title: "Schedule five design-partner interviews",
    state: "todo",
    assignee: "concierge",
    estimate: "S",
    tags: ["research", "customer"],
    body: "Recruit a mix of new and experienced automation users for moderated onboarding sessions.",
    criteria: ["Five sessions confirmed", "Participant mix covers three company sizes"],
    criteriaDone: 0,
  },
  {
    id: "T-20260907-9008",
    planId: demoPlans[1].id,
    title: "Compare setup completion by repository provider",
    state: "failing",
    assignee: "qa",
    estimate: "S",
    tags: ["analytics", "quality"],
    body: "Validate provider-level funnel reporting before the onboarding experiment begins.",
    criteria: ["GitHub and GitLab segments reconcile", "Unknown providers stay below 2%"],
    criteriaDone: 1,
  },
  {
    id: "T-20260907-9009",
    planId: demoPlans[2].id,
    title: "Repair keyboard focus order in task detail",
    state: "merged",
    assignee: "implementor",
    estimate: "M",
    tags: ["frontend", "a11y"],
    body: "Make task metadata, criteria, notes, and run controls follow a predictable keyboard order.",
    criteria: ["Tab order matches visual order", "Focus never enters hidden controls", "Manual screen-reader check passes"],
    criteriaDone: 3,
  },
  {
    id: "T-20260907-9010",
    planId: demoPlans[2].id,
    title: "Raise color contrast across status treatments",
    state: "merged",
    assignee: "designer",
    estimate: "S",
    tags: ["design-system", "a11y"],
    body: "Tune text, border, and status colors against both application surfaces.",
    criteria: ["Text meets AA contrast", "Status is never encoded by color alone", "Visual regression snapshots approved"],
    criteriaDone: 3,
  },
  {
    id: "T-20260907-9011",
    planId: demoPlans[2].id,
    title: "Retire the redundant accessibility overlay",
    state: "cancelled",
    assignee: null,
    estimate: "XS",
    tags: ["cleanup"],
    body: "Cancelled after native controls covered the intended behavior more reliably.",
    criteria: ["Overlay usage audited"],
    criteriaDone: 0,
  },
  {
    id: "T-20260907-9012",
    planId: demoPlans[3].id,
    title: "Curate a baseline suite of repository tasks",
    state: "todo",
    assignee: "planner",
    estimate: "M",
    tags: ["evaluation", "dataset"],
    body: "Select representative bug fixes, refactors, and feature tasks with stable verification commands.",
    criteria: ["Covers at least four task archetypes", "Every fixture has a deterministic oracle", "Licensing is documented"],
    criteriaDone: 0,
  },
];

const demoRuns = [
  { taskId: "T-20260907-9001", status: "running", personaId: "implementor", model: "claude-sonnet-4-6", branch: "demo/deployment-timeline", minutesAgo: 18, cost: 4.82, budget: 18, input: 48210, output: 12840 },
  { taskId: "T-20260907-9006", status: "preparing", personaId: "implementor", model: "gpt-5.4", branch: "demo/activation-events", minutesAgo: 4, cost: 0.36, budget: 12, input: 7200, output: 980 },
  { taskId: "T-20260907-9002", status: "completed", personaId: "qa", model: "claude-sonnet-4-6", branch: "demo/approval-gates", pr: 184, minutesAgo: 96, durationMinutes: 43, cost: 3.14, budget: 12, input: 29400, output: 8360 },
  { taskId: "T-20260907-9005", status: "completed", personaId: "designer", model: "gpt-5.4", branch: "demo/setup-checklist", pr: 187, minutesAgo: 61, durationMinutes: 34, cost: 2.76, budget: 10, input: 21800, output: 7140 },
  { taskId: "T-20260907-9008", status: "completed", personaId: "qa", model: "claude-sonnet-4-6", branch: "demo/provider-comparison", pr: 189, minutesAgo: 49, durationMinutes: 22, cost: 1.92, budget: 8, input: 17100, output: 4980 },
  { taskId: "T-20260907-9004", status: "failed", personaId: "qa", model: "claude-sonnet-4-6", branch: "demo/canary-verification", minutesAgo: 132, durationMinutes: 38, cost: 5.67, budget: 10, input: 44600, output: 9200, error: "Canary telemetry stream dropped during the eu-west verification window." },
  { taskId: "T-20260907-9009", status: "completed", personaId: "implementor", model: "gpt-5.4", branch: "demo/focus-order", pr: 176, minutesAgo: 1500, durationMinutes: 72, cost: 6.08, budget: 15, input: 53300, output: 15400 },
  { taskId: "T-20260907-9010", status: "completed", personaId: "designer", model: "claude-sonnet-4-6", branch: "demo/status-contrast", pr: 179, minutesAgo: 980, durationMinutes: 51, cost: 4.41, budget: 12, input: 38700, output: 11320 },
] as const;

async function main() {
  const { and, eq } = await import("drizzle-orm");
  const { db, closeDb, initDb } = await import("../db/index");
  const { agentSessions } = await import("../db/schema");
  const repo = await import("../lib/repo");

  try {
    await initDb();
    if (process.env.SEED_DEMO !== "1") {
      console.log("Seeded personas. Set SEED_DEMO=1 to also seed the demo workspace.");
      return;
    }

    console.log("Seeding demo workspace…");
    if (!(await repo.getRepository(DEMO_REPO_ID))) {
      await repo.createRepository({
        id: DEMO_REPO_ID,
        name: "Atlas web",
        remote: "https://github.com/example/atlas-web.git",
        defaultBranch: "main",
        description: "Demo repository for the populated Task Orchestrator workspace.",
      });
      console.log(`  + ${DEMO_REPO_ID}`);
    }

    for (const plan of demoPlans) {
      if (await repo.getPlan(plan.id)) continue;
      await repo.createPlan({
        id: plan.id,
        title: plan.title,
        state: plan.state,
        owner: plan.owner,
        tags: plan.tags,
        body: plan.body,
        repoIds: [DEMO_REPO_ID],
      });
      console.log(`  + ${plan.id}`);
    }

    for (const task of demoTasks) {
      if (await repo.getTask(task.id)) continue;
      const created = await repo.createTask({
        id: task.id,
        planId: task.planId,
        repoId: DEMO_REPO_ID,
        title: task.title,
        assignee: task.assignee,
        body: task.body,
        estimate: task.estimate,
        tags: task.tags,
        criteria: task.criteria,
        dependencies: task.dependencies,
      });
      for (const criterion of created.criteria.slice(0, task.criteriaDone)) {
        await repo.updateCriterion(criterion.id, { done: true }, task.id);
      }
      if (task.state === "cancelled") {
        await repo.transitionTask(task.id, { state: "cancelled" });
      } else if (task.state !== "todo") {
        await repo.transitionTask(task.id, {
          state: "in_progress",
          assignee: task.assignee ?? undefined,
        });
        if (task.state !== "in_progress") {
          await repo.transitionTask(task.id, {
            state: task.state,
            enforceCriteria: task.state === "merged",
          });
        }
      }
      if (task.note) await repo.addNote(task.id, task.note.author, task.note.body);
      console.log(`  + ${task.id} (${task.state})`);
    }

    // Complete the one intentionally shipped plan after all of its non-cancelled
    // tasks have reached merged. This respects the normal plan state machine.
    const shippedPlan = demoPlans.find((p) => "finalState" in p);
    if (shippedPlan) {
      const current = await repo.getPlan(shippedPlan.id);
      if (current?.state === "accepted") {
        await repo.updatePlan(shippedPlan.id, { state: "done" });
      }
    }

    const taskById = new Map(demoTasks.map((task) => [task.id, task]));
    const now = Date.now();
    for (const run of demoRuns) {
      const marker = `demo-seed:${run.taskId}`;
      const existing = await db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(and(eq(agentSessions.taskId, run.taskId), eq(agentSessions.sdkSessionId, marker)));
      if (existing.length > 0) {
        // Active demo rows are display fixtures, not dispatchable work. Keep
        // them on the server runtime so the pending-run pump ignores them, and
        // repair rows that an older version of this seed let reconciliation
        // mark failed before it could be upgraded.
        if (run.status === "running" || run.status === "preparing") {
          await db
            .update(agentSessions)
            .set({
              status: run.status,
              runtime: "server",
              backend: "pi",
              goal: "<chat>",
              toolsProfile: "orchestrator",
              cwdStrategy: "none",
              workerScope: `demo-fixture:${run.taskId}`,
              error: null,
              completedAt: null,
            })
            .where(eq(agentSessions.id, existing[0].id));
        }
        continue;
      }
      const task = taskById.get(run.taskId)!;
      const startedAt = new Date(now - run.minutesAgo * 60_000);
      const duration = "durationMinutes" in run ? run.durationMinutes : null;
      const completedAt = duration === null ? null : new Date(startedAt.getTime() + duration * 60_000);
      const prUrl = "pr" in run ? `https://github.com/example/atlas-web/pull/${run.pr}` : null;
      await db.insert(agentSessions).values({
        taskId: run.taskId,
        planId: task.planId,
        repoId: DEMO_REPO_ID,
        status: run.status,
        model: run.model,
        backend:
          run.status === "running" || run.status === "preparing"
            ? "pi"
            : run.model.startsWith("gpt")
              ? "codex"
              : "claude",
        branch: run.branch,
        prUrl,
        error: "error" in run ? run.error : null,
        totalCostUsd: run.cost,
        inputTokens: run.input,
        outputTokens: run.output,
        sdkSessionId: marker,
        goal: run.status === "running" || run.status === "preparing" ? "<chat>" : "<implement>",
        // Active runs are inert visual fixtures. `server` excludes them from
        // worker dispatch/reconciliation while still exercising live UI state.
        runtime: run.status === "running" || run.status === "preparing" ? "server" : "worker",
        thinkingLevel: "high",
        toolsProfile:
          run.status === "running" || run.status === "preparing"
            ? "orchestrator"
            : "orchestrator,repo_write",
        cwdStrategy: run.status === "running" || run.status === "preparing" ? "none" : "worktree",
        budgetMaxTurns: 40,
        budgetMaxUsd: run.budget,
        budgetMaxSeconds: 3600,
        outcome: run.status === "completed" ? "Demo run completed successfully." : null,
        title: task.title,
        personaId: run.personaId,
        baseBranch: "main",
        autoMerge: false,
        workerScope:
          run.status === "running" || run.status === "preparing"
            ? `demo-fixture:${run.taskId}`
            : null,
        startedAt,
        completedAt,
      });
      console.log(`  + run for ${run.taskId} (${run.status})`);
    }

    console.log("Demo workspace ready.");
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
