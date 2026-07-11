// Seeds the personas the DB needs as FK targets for agent_runs.persona_id.
//
// A demo plan + tasks can also be seeded for an empty first-run, but only when
// explicitly requested with SEED_DEMO=1 (npm run db:seed:demo). The default
// `db:seed` is persona-only, so running it never writes plans/tasks into a
// real database.
//
// Load .env.local FIRST so `npm run db:seed` seeds the same database the
// deployed service uses (db/index.ts reads process.env.TASK_ORCH_DB at import
// time). Under this project's ESM runtime a static import is evaluated before
// this module's body runs, so config() would fire too late; the db-touching
// modules (../lib/repo, ../db/seed-personas) are therefore imported
// *dynamically* inside main(), after config() has populated the environment.
import { config } from "dotenv";
config({ path: ".env.local" });

const SEED_PLAN_ID = "P-2026-05-11-task-system";

async function main() {
  const repo = await import("../lib/repo");
  const { seedPersonas } = await import("../db/seed-personas");

  // Personas are FK targets for agent_runs.persona_id; seed them every time so
  // CLI flows (which never boot instrumentation.ts) still find them.
  await seedPersonas();

  if (process.env.SEED_DEMO !== "1") {
    console.log("Seeded personas. Set SEED_DEMO=1 to also seed the demo plan.");
    return;
  }

  if (await repo.getPlan(SEED_PLAN_ID)) {
    console.log(`Seed plan ${SEED_PLAN_ID} already exists — skipping.`);
    return;
  }
  console.log("Seeding demo data…");
  const plan = await repo.createPlan({
    id: SEED_PLAN_ID,
    title: "Markdown Task System",
    state: "accepted",
    owner: "claude",
    tags: ["tooling", "agents", "meta"],
    body:
      "# Goal\n\nGive humans and AI agents a shared way to plan and execute software development. " +
      "Plans and tasks live in a SQLite database maintained by the server, with a Linear-style web UI and a CLI.\n\n" +
      "# Approach\n\n- Drizzle ORM + better-sqlite3 in the Next.js app\n- API routes for all CRUD + state transitions\n- CLI imports the same repo functions — no separate codepath\n- Web UI: server-rendered, with inline interaction for acceptance criteria\n",
  });
  console.log(`  + ${plan.id}`);

  const tasks = [
    {
      title: "SQLite + Drizzle schema (plans, tasks, notes, criteria, deps)",
      state: "merged" as const,
      criteria: [
        "Five tables with FKs and cascades",
        "Initial SQL migration applied on first boot",
        "JSON tags column (parsed on hydration)",
      ],
      tags: ["db", "schema"],
    },
    {
      title: "Repo layer with state-transition enforcement",
      state: "merged" as const,
      criteria: [
        "createPlan / createTask / updateTask",
        "transitionTask rejects invalid moves",
        "Acceptance criteria gate the done transition",
      ],
      tags: ["backend"],
    },
    {
      title: "REST API under app/api/{plans,tasks}",
      state: "merged" as const,
      criteria: [
        "GET/POST collections, PATCH/DELETE items",
        "Zod-validated request bodies",
        "Errors map RepoError.status correctly",
      ],
      tags: ["backend", "api"],
    },
    {
      title: "Linear-style UI (Kanban + detail pages)",
      state: "merged" as const,
      criteria: [
        "Dashboard groups tasks by state",
        "Task detail shows criteria, notes, deps",
        "Criteria checkbox calls API and refreshes",
      ],
      tags: ["frontend"],
    },
    {
      title: "CLI shares the repo layer (no HTTP needed)",
      state: "in_progress" as const,
      assignee: "claude",
      tags: ["cli", "dx"],
      criteria: [
        "list / show / new / transition / note / crit",
        "Same DB the server writes to",
        "Documented in AGENTS.md",
      ],
    },
  ];

  let i = 1;
  const ids: string[] = [];
  for (const t of tasks) {
    const task = await repo.createTask({
      id: `T-20260511-${String(i).padStart(4, "0")}`,
      planId: plan.id,
      title: t.title,
      assignee: t.assignee ?? null,
      tags: t.tags,
      criteria: t.criteria,
    });
    ids.push(task.id);
    console.log(`  + ${task.id}  ${task.title}`);
    if (t.state === "merged") {
      // Tick all criteria, then move through testing → merged.
      const full = (await repo.getTask(task.id))!;
      for (const c of full.criteria) await repo.updateCriterion(c.id, { done: true });
      await repo.transitionTask(task.id, { state: "in_progress", assignee: "claude" });
      await repo.transitionTask(task.id, { state: "testing" });
      await repo.transitionTask(task.id, { state: "merged" });
    } else if (t.state === "in_progress") {
      await repo.transitionTask(task.id, { state: "in_progress", assignee: t.assignee });
    }
    i++;
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
