import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TaskRepoSelector } from "@/components/task-repo-selector";
import * as repo from "@/lib/repo";
import * as runs from "@/lib/runs";
import { StateIcon } from "@/components/state-icon";
import { StateChanger } from "@/components/state-changer";
import { MarkdownBody } from "@/components/markdown-body";
import { CriterionCheckbox } from "@/components/criterion-checkbox";
import { TaskAgentButton } from "@/components/task-agent-button";
import { ResolveMergeButton } from "@/components/resolve-merge-button";
import { DeleteButton } from "@/components/delete-button";
import { TaskChatBox } from "@/components/task-chat-box";
import { buildChatPromptPrefix } from "@/lib/run-templates";
import { SessionStatusPill } from "@/components/session-status-pill";
import { AddNoteForm } from "@/components/add-note-form";
import { AddCriterionForm } from "@/components/add-criterion-form";
import { Attachments, AttachmentsHeading } from "@/components/attachments";
import { Meta } from "@/components/meta";
import { formatDate, formatDateTime, relativeDate } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { ListPanel } from "@/components/ui/list-panel";
import { PageSection } from "@/components/ui/page-section";
import { PrLink } from "@/components/pr-link";
import { branchUrlFromRemote } from "@/lib/gh-url";
import { GitBranch } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await repo.getTask(id);
  if (!task) notFound();

  const plan = await repo.getPlan(task.planId);
  const deps = (await Promise.all(task.dependencies.map((depId) => repo.getTask(depId)))).filter(
    (t): t is NonNullable<typeof t> => Boolean(t)
  );
  // The task's single attached run (one canonical session), if any.
  const attachedRun = await repo.resolveAttachedRun(task.id);
  // Inbox: every run scoped to this task (chat + implement + review),
  // newest first, capped at the 10 most recent so the page doesn't grow
  // unbounded. listRuns already orders by startedAt desc. Pin the attached
  // run to the top so a return visit lands on it in one click.
  const allRuns = await runs.listRuns({ taskId: task.id });
  const inbox = [
    ...allRuns.filter((r) => r.id === attachedRun?.id),
    ...allRuns.filter((r) => r.id !== attachedRun?.id),
  ].slice(0, 10);
  // The task's latest PR (denormalised onto TaskFull from its most recent run).
  const latestPr = task.prUrl;
  const repository = task.repoId ? await repo.getRepository(task.repoId) : null;
  // The task's canonical branch (every agent run works this one branch),
  // falling back to the attached run's branch for pre-migration tasks.
  const taskBranch = task.branch ?? attachedRun?.branch ?? null;
  const branchUrl = taskBranch ? branchUrlFromRemote(repository?.remote ?? null, taskBranch) : null;
  const planRepoOptions = plan?.repos ?? [];
  const chatPromptPrefix = buildChatPromptPrefix(task, latestPr);
  const personas = await repo.listPersonas();

  return (
    <article className="mx-auto max-w-3xl">
      <Link
        href={plan ? `/plans/${plan.id}` : "/tasks"}
        className="inline-flex items-center gap-1 max-w-full text-xs text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft className="size-3.5 shrink-0" />
        <span className="truncate">{plan ? plan.title : "Tasks"}</span>
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <StateIcon state={task.state} className="size-4" />
            <span className="tabular-nums">{task.id}</span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-tight">{task.title}</h1>
        </div>
        <div className="flex flex-row sm:flex-col items-start sm:items-end gap-2 sm:gap-1.5 flex-wrap">
          {task.state !== "merged" && task.state !== "cancelled" && (
            <TaskAgentButton taskId={task.id} hasAttachedRun={Boolean(attachedRun)} />
          )}
          <ResolveMergeButton taskId={task.id} />
          <DeleteButton
            endpoint={`/api/tasks/${task.id}`}
            redirectTo={plan ? `/plans/${plan.id}` : "/tasks"}
            confirmMessage={`Delete task "${task.title}"? This cannot be undone.`}
            label="Delete task"
          />
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
                <Chip key={t} className="bg-transparent px-1.5 py-px text-[10px] uppercase tracking-wide">
                  {t}
                </Chip>
              ))}
            </div>
          </Meta>
        ) : null}
        {taskBranch && (
          <Meta label="Branch" className="col-span-2 md:col-span-4">
            {branchUrl ? (
              <a
                href={branchUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-foreground hover:underline decoration-dotted"
              >
                <GitBranch className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{taskBranch}</span>
              </a>
            ) : (
              <code className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{taskBranch}</span>
              </code>
            )}
          </Meta>
        )}
        {latestPr && (
          <Meta label="Pull request" className="col-span-2 md:col-span-4">
            <PrLink url={latestPr} variant="badge" external />
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

      <PageSection className="mt-0" title="Description">
        <MarkdownBody source={task.body} />
      </PageSection>

      <PageSection
        title="Acceptance criteria"
        action={
          task.criteria.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {task.criteria.filter((c) => c.done).length} / {task.criteria.length} done
            </span>
          ) : null
        }
      >
        {task.criteria.length === 0 && <EmptyState className="italic">No criteria yet.</EmptyState>}
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
      </PageSection>

      <PageSection
        title="Notes"
        action={<AddNoteForm taskId={task.id} defaultAuthor={task.assignee ?? undefined} />}
      >
        {task.notes.length === 0 ? (
          <EmptyState className="italic">No notes yet.</EmptyState>
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
      </PageSection>

      <PageSection>
        <AttachmentsHeading count={task.attachments.length} />
        <Attachments scope="task" ownerId={task.id} attachments={task.attachments} />
      </PageSection>

      <PageSection title="Inbox">
        {inbox.length === 0 ? (
          <EmptyState className="italic">
            No runs yet. Start one with the buttons above, or ask the agent in the chat box below.
          </EmptyState>
        ) : (
          <ListPanel>
            {inbox.map((r) => (
              <div
                key={r.id}
                className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors group"
              >
                <Link
                  href={`/runs/${r.id}`}
                  className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0"
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0">
                    #{r.id}
                  </span>
                  <Tooltip content={`goal: ${r.goal}`}>
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/80 shrink-0">
                      {goalLabel(r.goal)}
                    </span>
                  </Tooltip>
                  <SessionStatusPill status={r.status} />
                  {r.branch && (
                    <code className="font-mono text-[11px] text-muted-foreground truncate">
                      {r.branch}
                    </code>
                  )}
                </Link>
                <div className="flex items-center gap-3 pl-0 sm:pl-0">
                  {r.prUrl && (
                    <PrLink
                      url={r.prUrl}
                      iconClassName="size-3"
                      external
                      className="hover:underline decoration-dotted"
                    />
                  )}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {relativeDate(r.startedAt)}
                  </span>
                </div>
              </div>
            ))}
          </ListPanel>
        )}
      </PageSection>

      <PageSection title="Chat about this task">
        <TaskChatBox
          taskId={task.id}
          repoId={task.repoId ?? null}
          promptPrefix={chatPromptPrefix}
          personas={personas}
        />
      </PageSection>
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

