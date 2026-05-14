// Next.js 13+ runtime hook: invoked once per process on first request /
// cold start. We use it to start the hourly worktree-GC sweep when
// TASK_ORCH_WORKTREE_GC is truthy. The sweep is itself idempotent (holds
// its timer on globalThis so HMR doesn't spawn duplicates), but gating
// here keeps the dev console quiet for everyone who doesn't opt in.
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register(): Promise<void> {
  // Only run on the Node.js server runtime — edge runtime can't spawn git
  // or load better-sqlite3 (which lib/worktree-gc.ts pulls in transitively
  // via the orchestrator DB).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Hide the import from webpack's static tracer so the edge bundle doesn't
  // try to resolve the better-sqlite3 chain.
  const modPath = "./lib/worktree-gc";
  const mod = (await import(/* webpackIgnore: true */ modPath)) as {
    startWorktreeGc: () => void;
  };
  mod.startWorktreeGc();

  // Same webpackIgnore trick as above — hides better-sqlite3 (pulled in via
  // db/seed-personas → lib/repo → db/index) from the edge bundle tracer.
  const seedPath = "./db/seed-personas";
  const seedMod = (await import(/* webpackIgnore: true */ seedPath)) as {
    seedPersonas: () => void;
  };
  seedMod.seedPersonas();
}
