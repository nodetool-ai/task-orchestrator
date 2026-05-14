// Next.js 13+ runtime hook: invoked once per process on first request /
// cold start.
//
// Historically this started the hourly worktree-GC sweep when
// TASK_ORCH_WORKTREE_GC was truthy. The dynamic import survives `next dev`
// (tsx loader resolves the .ts file at runtime) but loses its
// /* webpackIgnore: true */ annotation under `next build`, so the prod
// bundle hard-fails on `Cannot find module .next/server/lib/worktree-gc`
// at boot.
//
// For now, gate every side effect behind the env flag so production (which
// doesn't set TASK_ORCH_WORKTREE_GC) skips the import entirely. The worktree
// GC sweep can run from a cron / one-shot script when needed.
//
// Persona seeding is handled by `npm run db:seed` (scripts/seed.ts), not here.
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.TASK_ORCH_WORKTREE_GC) return;

  const modPath = "./lib/worktree-gc";
  const mod = (await import(/* webpackIgnore: true */ modPath)) as {
    startWorktreeGc: () => void;
  };
  mod.startWorktreeGc();
}
