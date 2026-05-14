import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, GitPullRequest } from "lucide-react";
import { TaskRepoSelector } from "@/components/task-repo-selector";
import * as repo from "@/lib/repo";
import * as agent from "@/lib/agent";
import * as runs from "@/lib/runs";
import { StateIcon } from "@/components/state-icon";
import { StateChanger } from "@/components/state-changer";
import { MarkdownBody } from "@/components/markdown-body";
import { CriterionCheckbox } from "@/components/criterion-checkbox";
import { RunAgentButton } from "@/components/run-agent-button";
import { RunReviewButton } from "@/components/run-review-button";
import { TaskChatBox } from "@/components/task-chat-box";
import {
  IMPLEMENT_DEFAULT_BUDGET_USD,
  REVIEW_DEFAULT_BUDGET_USD,
  buildChatPromptPrefix,
  buildImplementPrompt,
  buildReviewPrompt,
} from "@/lib/run-templates";
import { SessionStatusPill } from "@/components/session-status-pill";
import { AddNoteForm } from "@/components/add-note-form";
import { AddCriterionForm } from "@/components/add-criterion-form";
import { Meta } from "@/components/meta";
import { formatDate, formatDateTime, relativeDate } from "@/lib/utils";
import { isTerminalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Render a GitHub PR URL as `owner/repo#NNN` (or just the URL for non-GH hosts).
function prShortLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = repo.getTask(id);
  if (!task) notFound();

  const plan = repo.getPlan(task.planId);
  const deps = task.dependencies
    .map((depId) => repo.getTask(depId))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const sessions = agent.listSessions(task.id);
  const activeSession = sessions.find((s) => !isTerminalStatus(s.status));
  // Inbox: every run scoped to this task (chat + implement + review),
  // newest first, capped at the 10 most recent so the page doesn't grow
  // unbounded. listRuns already orders by startedAt desc.
  const inbox = runs.listRuns({ taskId: task.id }).slice(0, 10);
  // Sessions are listed newest-first; first one with a PR is the latest PR.
  const latestPr = sessions.find((s) => s.prUrl)?.prUrl ?? null;
  const repository = task.repoId ? repo.getRepository(task.repoId) : null;
  const planRepoOptions = plan?.repos ?? [];
  const chatPromptPrefix = buildChatPromptPrefix(task, latestPr);
  const personas = repo.listPersonas();

  return (
    <article className="mx-auto max-w-3xl">
      <Link
        href="/tasks"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="size-3.5" /> Tasks
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <StateIcon state={task.state} className="size-4" />
            <span className="tabular-nums">{task.id}</span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-tight">{task.title}</h1>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <RunAgentButton
            taskId={task.id}
            hasActive={Boolean(activeSession)}
            initialPrompt={buildImplementPrompt(task)}
            budgetMaxUsd={IMPLEMENT_DEFAULT_BUDGET_USD}
            personas={personas}
          />
          {latestPr && (
            <RunReviewButton
              taskId={task.id}
              prUrl={latestPr}
              initialPrompt={buildReviewPrompt(task, latestPr)}
              budgetMaxUsd={REVIEW_DEFAULT_BUDGET_USD}
            />
          )}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-6 text-xs">
        <Meta label="State">
          <StateChanger taskId={task.id} current={task.state} assignee={task.assignee} />
        </Meta>
        <Meta label="Assignee">{task.assignee ? `@${task.assignee}` : "—"}</Meta>
        <Meta label="Plan">
          {plan ? (
            <Link href={`/plans/${plan.id}`} className="text-foreground hover:underline">
              {plan.title}
            </Link>
          ) : (
            <span className="text-muted-foreground">{task.planId}</span>
          )}
        </Meta>
        <Meta label="Repository">
          <TaskRepoSelector
            taskId={task.id}
            currentRepoId={task.repoId}
            currentRepo={repository}
            options={planRepoOptions}
          />
        </Meta>
        <Meta label="Updated" hint={relativeDate(task.updatedAt)}>
          {formatDate(task.updatedAt)}
        </Meta>
        {task.estimate && <Meta label="Estimate">{task.estimate}</Meta>}
        {task.tags?.length ? (
          <Meta label="Tags">
            <div className="flex flex-wrap gap-1">
              {task.tags.map((t) => (
                <span
                  key={t}
                  className="rounded border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-wide"
                >
                  {t}
                </span>
              ))}
            </div>
          </Meta>
        ) : null}
        {latestPr && (
          <Meta label="Pull request" className="col-span-2 md:col-span-4">
            <a
              href={latestPr}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-xs hover:bg-secondary transition-colors"
            >
              <GitPullRequest className="size-3.5 text-state-review" />
              <span className="font-mono text-foreground">{prShortLabel(latestPr)}</span>
              <span className="text-muted-foreground">↗</span>
            </a>
          </Meta>
        )}
        {deps.length > 0 && (
          <Meta label="Depends on" className="col-span-2 md:col-span-4">
            <div className="flex flex-wrap gap-2">
              {deps.map((d) => (
                <Link
                  key={d.id}
                  href={`/tasks/${d.id}`}
                  className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-secondary/40 px-2 py-1 hover:bg-secondary"
                >
                  <StateIcon state={d.state} />
                  <span className="font-mono tabular-nums">{d.id}</span>
                  <span className="text-muted-foreground">{d.title}</span>
                </Link>
              ))}
            </div>
          </Meta>
        )}
      </dl>

      <div className="my-8 h-px bg-border/60" />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Description</h2>
        <MarkdownBody source={task.body} />
      </section>

      <section className="mt-10 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Acceptance criteria</h2>
          {task.criteria.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {task.criteria.filter((c) => c.done).length} / {task.criteria.length} done
            </span>
          )}
        </div>
        {task.criteria.length === 0 && (
          <p className="text-xs text-muted-foreground italic">No criteria yet.</p>
        )}
        <ul className="space-y-0">
          {task.criteria.map((c) => (
            <CriterionCheckbox
              key={c.id}
              taskId={task.id}
              criterionId={c.id}
              initialDone={c.done}
              text={c.text}
            />
          ))}
        </ul>
        <AddCriterionForm taskId={task.id} />
      </section>

      <section className="mt-10 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Notes</h2>
          <AddNoteForm taskId={task.id} defaultAuthor={task.assignee ?? undefined} />
        </div>
        {task.notes.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No notes yet.</p>
        ) : (
          <ol className="space-y-3">
            {task.notes.map((n) => (
              <li key={n.id} className="rounded-md border border-border/60 bg-card/30 px-4 py-3">
                <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
                  <span>
                    <span className="text-foreground/80">@{n.author}</span>
                    {" · "}
                    {formatDateTime(n.createdAt)}
                  </span>
                  <span>{relativeDate(n.createdAt)}</span>
                </div>
                <div className="mt-1.5 text-sm whitespace-pre-wrap text-foreground/90">{n.body}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Inbox</h2>
        {inbox.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No runs yet. Start one with the buttons above, or ask the agent in the chat box below.
          </p>
        ) : (
          <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
            {inbox.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors group"
              >
                <Link
                  href={`/runs/${r.id}`}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    #{r.id}
                  </span>
                  <span
                    className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/80"
                    title={`goal: ${r.goal}`}
                  >
                    {goalLabel(r.goal)}
                  </span>
                  <SessionStatusPill status={r.status} />
                  {r.branch && (
                    <code className="font-mono text-[11px] text-muted-foreground truncate">
                      {r.branch}
                    </code>
                  )}
                </Link>
                {r.prUrl && (
                  <a
                    href={r.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline decoration-dotted"
                  >
                    <GitPullRequest className="size-3" />
                    {prShortLabel(r.prUrl)}
                    <span>↗</span>
                  </a>
                )}
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {relativeDate(r.startedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Chat about this task</h2>
        <TaskChatBox
          taskId={task.id}
          repoId={task.repoId ?? null}
          promptPrefix={chatPromptPrefix}
          personas={personas}
        />
      </section>
    </article>
  );
}

// Short uppercase label for an inbox row's run kind. Goal strings are
// surrounded by angle brackets in storage (`<implement>`, `<chat>`, `<review>`);
// strip those for display, and fall back to the raw goal otherwise.
function goalLabel(goal: string): string {
  const m = goal.match(/^<(.+)>$/);
  return (m ? m[1] : goal).toUpperCase();
}

