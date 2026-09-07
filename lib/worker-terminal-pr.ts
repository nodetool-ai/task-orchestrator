// Control-plane terminal PR handoff for detached workers.
//
// The worker performs git inspection/push in its own checkout, then invokes
// this tool over the durable worker channel. GitHub and task persistence stay
// here so a worker never gains database access and the control plane never
// shells out in a worker-owned path.

import { Type } from "typebox";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions } from "@/db/schema";
import { getOctokit } from "./github-client";
import { ownerRepoFromRemote, parsePrUrl } from "./gh-url";
import * as repo from "./repo";
import type { OrchestratorTool } from "./orchestrator-tools";

function result(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function prBody(task: NonNullable<Awaited<ReturnType<typeof repo.getTask>>>, summary: string | null): string {
  const sections = [summary?.trim() || task.body.trim(), "---", `Closes task **${task.id}**: ${task.title}.`].filter(Boolean);
  if (task.criteria.length) {
    sections.push(`### Acceptance criteria\n${task.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

/** Internal-only channel tool. It is never mounted into an agent profile; the
 * worker driver calls it after a successful local push and waits for its durable
 * tool.result before emitting run.finished. */
export const WORKER_TERMINAL_PR_TOOLS: OrchestratorTool[] = [
  {
    name: "worker__open_terminal_pr",
    label: "Open worker terminal PR",
    description: "Internal worker lifecycle tool.",
    parameters: Type.Object({
      branch: Type.String({ minLength: 1 }),
      baseBranch: Type.String({ minLength: 1 }),
      summary: Type.Optional(Type.String()),
    }),
    execute: async ({ branch, baseBranch, summary }, ctx) => {
      if (!ctx.runId) return result("Terminal PR handoff requires a run context.", true);
      const [run] = await db.select().from(agentSessions).where(eq(agentSessions.id, ctx.runId)).limit(1);
      if (!run?.taskId || !run.branch || run.goal !== "<implement>") {
        return result("Run has no implementation task/branch for a terminal PR.", true);
      }
      if (run.branch !== branch || run.baseBranch !== baseBranch) {
        return result("Terminal PR handoff branch does not match the durable run branch/base.", true);
      }

      const task = await repo.getTask(run.taskId);
      const repository = run.repoId ? await repo.getRepository(run.repoId) : await repo.resolveRepoForTask(run.taskId);
      const target = ownerRepoFromRemote(repository?.remote ?? null);
      if (!task || !target) return result("Task repository has no GitHub remote for PR creation.", true);

      try {
        let prUrl = run.prUrl ?? task.prUrl;
        if (!prUrl) {
          const { data } = await getOctokit().pulls.create({
            owner: target.owner,
            repo: target.repo,
            title: `[${task.id}] ${task.title}`,
            body: prBody(task, summary ?? null),
            base: baseBranch,
            head: branch,
          });
          prUrl = data.html_url ?? null;
        }
        if (!prUrl) return result("GitHub did not return a pull request URL.", true);
        const parsed = parsePrUrl(prUrl);
        if (!parsed) return result("GitHub returned an invalid pull request URL.", true);

        await repo.setTaskPr(task.id, parsed.canonical);
        if (task.state === "in_progress") {
          await repo.transitionTask(task.id, {
            state: "testing",
            note: `PR opened: ${parsed.canonical}`,
          });
        }
        if (run.autoMerge !== false) {
          // Opening/linking a valid PR succeeds independently of GitHub's
          // temporary auto-merge availability; mirrors the legacy best-effort
          // armAutoMerge behavior while retaining the mandated squash method.
          try {
            const { data: pr } = await getOctokit().pulls.get({
              owner: parsed.owner,
              repo: parsed.repo,
              pull_number: parsed.number,
            });
            await getOctokit().graphql(
              `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
                enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { clientMutationId }
              }`,
              { pullRequestId: pr.node_id, mergeMethod: "SQUASH" }
            );
          } catch (error) {
            console.warn(`Could not arm auto-merge for ${parsed.canonical}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return result(JSON.stringify({ prUrl: parsed.canonical }));
      } catch (error) {
        return result(`Could not open terminal PR: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  },
];
