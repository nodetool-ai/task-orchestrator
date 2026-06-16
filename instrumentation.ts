// Next.js 13+ runtime hook: invoked once per process on first request /
// cold start.
//
// The dynamic import for worktree-gc survives `next dev` (tsx loader resolves
// the .ts file at runtime) but loses its /* webpackIgnore: true */ annotation
// under `next build`, so the prod bundle hard-fails on missing module.
// Gate it behind TASK_ORCH_WORKTREE_GC so production skips it.
//
// Persona seeding uses a static import (no webpack issues) and runs
// insert-if-missing so it's safe on every cold start.
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
