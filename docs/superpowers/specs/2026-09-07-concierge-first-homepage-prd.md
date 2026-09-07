# Concierge-first homepage — PRD

**Date:** 2026-09-07  
**Status:** Draft  
**Product owner:** Task Orchestrator  
**Companion context:**
`2026-07-31-discord-personas-messaging-prd.md` (conversation principles),
`../../../SCHEMA.md` (current plans, tasks, runs, messages, and state machines)

This PRD defines what the new web start page does and what users see. It does
not prescribe component structure, database migrations, or visual styling
beyond behavior required for a coherent experience.

## 1. Product decision

The start page becomes a conversation with one concierge. The concierge is the
front door, the persistent accountable voice, and the place where work returns.
It may coordinate planners, implementors, reviewers, and other specialists, but
the user should not have to operate that team.

The concierge homepage is the expected path for roughly 80–95% of user
interactions. Plans, Tasks, Runs, and Schedules remain directly accessible in
the primary navigation for the remaining 5–20% of interactions that require
inspection, comparison, manual control, or debugging. Their current deep-dive
UX is retained. Progressive disclosure simplifies the default path; it does
not reduce access to operational truth or controls.

The homepage must answer three questions:

1. What can I ask my concierge to move forward?
2. Does anything need my attention?
3. Is the work I care about moving?

**One-line pitch:** Tell one trusted concierge what you want; it coordinates
the work and brings decisions and results back to you.

## 2. Problem and context

The current Overview is an effective operator dashboard. It leads with counts
for running, review, blocked, queued, and completed work, followed by run cards,
task queues, costs, token usage, personas, criteria, and controls. This is
valuable to someone debugging the machinery, but it asks every user to learn
the machinery before expressing intent.

The typical interaction is different: a person describes an outcome to a
concierge, the concierge coordinates specialists, and the person returns for a
decision or result. This conversational path should handle 80–95% of usage.
The operational surfaces remain important for the 5–20% of cases where a user
wants to scan a portfolio, compare task state, inspect a run, or exercise direct
control. Exposing all of that machinery inside the homepage itself:

- makes delegation feel like project administration;
- splits accountability across agent identities;
- turns status into a feed that the user must interpret;
- gives implementation state more visual weight than the user's goal; and
- makes quiet or first-time states look empty rather than inviting.

The product already has the necessary foundation: chat-style runs, persisted
messages, child runs, personas, plans, tasks, attachments, event streams, and
inspection pages. The new homepage reorganizes the default experience around
the relationship with the concierge without demoting or redesigning those
inspection pages.

## 3. Experience principles

These are product laws, not styling suggestions.

1. **Conversation is home.** The primary action is always sending a message to
   the concierge. A user can start useful work without creating a plan, task,
   run, or schedule manually.
2. **One accountable voice.** Specialists may contribute, but the concierge
   acknowledges the request, sets expectations, asks questions, and delivers
   the synthesis.
3. **Outcomes before machinery.** Say “Launch readiness is moving” before
   “three runs are active.” Use the user's language wherever possible.
4. **Attention, not activity.** Home surfaces decisions, exceptions, and
   meaningful completions. Background events remain quiet.
5. **Progressive disclosure on the default path.** A short human summary comes
   first in the conversation. Detail expands in context, while Plans, Tasks,
   Runs, and Schedules stay directly reachable from primary navigation at all
   times.
6. **Calm by default.** No empty dashboard grids, live telemetry wall, or
   celebratory noise. Empty space is acceptable.
7. **Make autonomy legible.** Before consequential work begins, the concierge
   states what it will do, material assumptions, when it will return, and what
   the user needs to do, if anything.
8. **The user can always inspect and intervene.** Simplicity must not hide
   failures, uncertainty, spending, permissions, or a real stop control.

## 4. Goals and non-goals

### Goals

- Make a natural-language request the obvious first action on desktop and
  mobile.
- Establish one concierge as the durable relationship across conversations.
- Let a returning user understand attention and momentum in under 10 seconds.
- Represent multi-agent work as a concise delegation receipt and synthesized
  outcome, not parallel agent chatter.
- Keep Plans, Tasks, Runs, and Schedules directly reachable with one primary-nav
  action and preserve their current deep-dive UX.
- Design explicitly for an 80–95% concierge path and a 5–20% direct operational
  path; neither path may depend on the other to be usable.
- Support lightweight approvals, clarifications, stop/resume actions, and
  artifact review without leaving home.
- Reuse existing conversation and orchestration capabilities where practical.

### Non-goals

- Replacing the detailed Plans, Tasks, Runs, or Schedules surfaces.
- Hiding, nesting, phasing out, or reducing the capability of Plans, Tasks,
  Runs, or Schedules in primary navigation.
- Providing a real-time operations dashboard on home.
- Letting users converse with multiple specialists in parallel inboxes on home.
- Showing raw chain-of-thought, internal prompts, tool calls, or complete agent
  transcripts.
- Building a general-purpose kanban board or notification center.
- Automatically merging, deploying, deleting, spending above policy, or taking
  other irreversible/high-impact actions without the existing applicable
  confirmation and permission gates.
- Requiring a new orchestration state machine solely for the homepage.

## 5. Target users and jobs

| User | Primary job | Homepage promise |
|---|---|---|
| Solo builder | “Take this outcome from idea to shipped work.” | Ask once; receive decisions and a result. |
| Team lead | “Tell me what needs me and whether priorities are moving.” | A short attention-first pulse, not a queue audit. |
| Occasional contributor | “Capture or investigate this without learning the system.” | Start in plain language with no setup taxonomy. |
| Power user/operator | “Inspect or intervene directly.” | Open Plans, Tasks, Runs, or Schedules from primary navigation without losing context. |
| Mobile user | “Reply, approve, stop, or capture an idea quickly.” | The full core loop works in one narrow conversation. |

Core jobs to be done:

- Start a new outcome from an incomplete request.
- Continue a prior conversation without reconstructing context.
- See and answer the one or two decisions blocking progress.
- Understand what the concierge delegated and when to expect an update.
- Review a result or artifact and request changes.
- Inspect or control underlying work directly whenever needed.

## 6. Information architecture and terminology

### 6.1 Primary navigation

The signed-in primary navigation is:

- **Home** — concierge conversation and Today pulse.
- **Plans** — current plan portfolio and plan detail UX.
- **Tasks** — current task state/grouping and task detail UX.
- **Runs** — current conversation/run inspection and control UX.
- **Schedules** — current schedule configuration and history UX.
- **Search** — searches conversations and underlying work.
- **Settings/account** — identity, repositories, models, permissions,
  integrations, usage, and preferences.

Plans, Tasks, Runs, and Schedules remain visible, equal-weight primary-nav
destinations on desktop. Home is selected by default because it serves the
majority conversational path, not because the operational destinations are
less capable or less accessible. Existing URLs and current page-level UX remain
valid.

### 6.2 User-facing nouns

| Prefer | Use for | Avoid on home by default |
|---|---|---|
| Concierge | The single agent the user talks to | Router, supervisor, orchestrator process |
| Conversation | One coherent user outcome or topic | Chat run, session |
| Work | The activity coordinated for an outcome | Job graph, execution tree |
| In motion | Work proceeding without user action | Running sessions |
| Needs you | A specific decision, approval, clarification, or recovery choice | Blocked queue |
| Ready | A meaningful result available to review or use | Completed runs |
| Details | The next explanatory layer | Debug metadata |
| Operational surfaces | Plans, Tasks, Runs, and Schedules | Secondary-only tools, buried controls |

When task or run vocabulary is necessary in expanded details, use the canonical
states **Queued, Running, Review, Blocked, Completed, Cancelled** consistently.
Do not substitute “Todo” for “Queued” or “Awaiting review” for “Review.”

### 6.3 Conversation identity

- The product has one configured default concierge identity, name, avatar, and
  voice per workspace/deployment.
- The same concierge appears across every homepage conversation.
- A new request creates a new conversation; it does not create a new concierge.
- Conversation titles describe the user outcome and may be proposed/updated by
  the concierge. They do not begin with task or run IDs.
- Home opens the most recently active unresolved conversation. If none exists,
  it opens the calm start state.

## 7. Core desktop experience

Desktop uses three regions, only two of which are required:

1. **Conversation rail (quiet, collapsible):** New request, recent
   conversations, and archive/search affordances. It shows outcome title and
   one meaningful state at most. It does not duplicate global navigation or
   show agent counts/event badges.
2. **Conversation (primary):** Concierge identity, transcript, inline action or
   artifact cards, and a persistent composer. This region receives most width
   and visual emphasis.
3. **Today rail (small, collapsible):** Needs you, In motion, and Ready. It is
   omitted when it has no useful content.

Recommended wide-desktop proportions are approximately 18% / 58% / 24%, with
a minimum comfortable conversation width of 600 px. The rails collapse before
the conversation becomes cramped.

### 7.1 Conversation header

Show:

- concierge name and avatar;
- a plain availability state such as “Here now,” “Working,” or “Reconnecting”;
- conversation title when one exists; and
- a compact overflow menu for rename, mute notifications, archive, and view
  details.

Do not show model, provider, persona picker, run ID, token count, branch,
worktree, or cost in the default header.

### 7.2 Transcript

The transcript contains:

- user and concierge messages;
- explicit assumption/plan statements before consequential delegation;
- one updating delegation receipt per active outcome;
- decision cards with a single primary action when structured input is useful;
- synthesized results with links or inline artifacts; and
- concise error/recovery messages.

Tool chatter, shell output, intermediate specialist messages, repeated progress
events, and raw logs never enter the default transcript.

### 7.3 Composer

- Placeholder: **“Ask [concierge name] anything…”**
- Supports multiline text, attachments, send, and an accessible stop action
  while the concierge is responding.
- Suggested prompts are shown only in first-time or genuinely empty states,
  never as permanent clutter.
- Repository or plan scoping is inferred when confidence is high. If scope is
  material and ambiguous, the concierge asks one question with a suggested
  default. Pickers are available under composer options for power users.
- Sending the first message immediately creates/opens the conversation and
  places the user's message in the transcript. Navigation must not lose it.

### 7.4 Delegation receipt

After accepting work that requires specialists, the concierge writes a short
message and creates one receipt that updates in place:

> I’m checking rollout, customer impact, and rollback readiness. I’ll bring a
> recommendation back here by 14:30.

Receipt collapsed state:

- outcome-oriented label, e.g. **Work is moving**;
- completed/active workstream summary, e.g. **1 of 3 checks complete**;
- expectation, e.g. **Next update by 14:30**;
- attention state, e.g. **No action needed from you**; and
- **See details** disclosure.

Expanded state may show named workstreams, specialist roles, evidence/artifact
links, current milestone, last-updated time, and stop/pause controls. Task and
run IDs appear only in a further **Technical details** layer or on the linked
Plan, Task, or Run page.

### 7.5 Optional contextual artifact workbench

The concierge may open a side-by-side workbench when a substantial artifact is
the current subject: a brief, plan narrative, comparison, diff summary,
approval, schedule preview, or report.

Rules:

- It opens because the concierge delivered/referenced an artifact or because
  the user explicitly opened it, never merely because work is active.
- It shows one artifact at a time and preserves the composer.
- It is dismissible without losing the conversation.
- Comments or selections made in the workbench return to the same conversation.
- On widths below 1024 px it replaces the transcript temporarily and provides
  a clear Back to conversation action.
- A task table, raw run log, terminal, or generic dashboard is not an artifact
  workbench; open the existing Task or Run surface instead.

### 7.6 Desktop navigation reference

The persistent top navigation stays visible above the concierge layout:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Task Orchestrator  Home  Plans  Tasks  Runs  Schedules   Search  Account │
├───────────────┬──────────────────────────────────┬───────────────────────┤
│ + New request │ Concierge conversation           │ Today                 │
│               │                                  │ Needs you             │
│ Recent        │ Good morning. What would you     │ Approve launch copy   │
│ conversations │ like to move forward?            │                       │
│               │                                  │ In motion             │
│               │ [conversation and work receipt]  │ Release readiness     │
│               │                                  │                       │
│               │ [Ask your concierge anything…]   │ Ready                 │
│               │                                  │ Setup brief           │
└───────────────┴──────────────────────────────────┴───────────────────────┘
```

Contextual links use specific labels—**View plan**, **View task**, **Inspect
run**, or **View schedule**—and open the existing deep-dive surface. Do not use
a generic work-hub label.

## 8. Mobile experience

Mobile is conversation-first and single-column.

- The app opens directly to the latest conversation or start state.
- A top-left navigation control opens a drawer with Home, Plans, Tasks, Runs,
  Schedules, recent conversations, Search, and Settings. The five product
  destinations are individually labeled and reachable with one tap from the
  open drawer.
- A **Today** button carries a count only for unresolved Needs you items. It
  opens a full-height sheet ordered Needs you, In motion, Ready.
- The composer remains reachable above the software keyboard and safe-area
  inset. Attachments and stop controls remain available.
- Structured actions use full-width targets and never require hover.
- Expanded delegation details and artifacts open as full-screen sheets/pages
  with an explicit return path.
- Concierge replies default to phone-screen length; long results begin with a
  synthesis and place detail behind expansion.
- No horizontal tables, multi-column status grids, or persistent Today rail are
  permitted under 768 px.

## 9. State requirements

### 9.1 First-time state

Show the concierge, a two-sentence introduction, the composer, and at most
three example asks based on available repository/workspace context.

Recommended copy:

> **What would you like to move forward?**  
> Tell me the outcome. I can plan the work, bring in specialists, and return
> with decisions and results.

Examples: “Investigate this production error,” “Prepare the next release,” and
“Turn this idea into a small first step.” Do not present a setup checklist as
the main experience. If a repository/integration is required after the ask,
explain the benefit and ask for that one connection then.

### 9.2 Returning, quiet state

Open with a brief time-appropriate greeting and a resumption cue. If nothing
needs attention, say so once: **“Nothing needs you right now.”** Show up to
three recent conversations and the composer. Do not render empty Needs you,
In motion, or Ready boxes.

### 9.3 Active-work state

- Keep the user's latest exchange in focus.
- Show one updating delegation receipt for the conversation.
- Put an outcome-level In motion item in Today, not one item per specialist or
  run.
- Give a next-update expectation when the system can support it; otherwise say
  “I’ll update you at the next meaningful milestone.” Do not invent ETAs.
- Background updates do not steal focus or trigger celebratory animation.

### 9.4 Needs-input state

- The concierge states why progress cannot safely continue, its recommended
  option, and one direct question.
- Today places the item first under Needs you with a verb-led action label such
  as **Choose API shape**, **Approve merge**, or **Reconnect GitHub**.
- Opening the item scrolls to the exact conversational decision or opens its
  compact decision card.
- One decision card has one primary action and no more than two secondary
  choices before an expandable “Other” path.
- Do not label ordinary Review work as Needs you unless the user truly owns the
  next action.

### 9.5 Completed/ready state

- The concierge delivers a synthesis: outcome, material changes, evidence,
  known limits, and next action.
- Today shows the outcome under Ready until the user opens/acknowledges it or
  for seven days, whichever comes first.
- The transcript may show a primary artifact or review action. Confetti,
  fireworks, and one card per completed subtask are prohibited.
- A completed conversation remains searchable and may be continued; continuing
  it does not mutate terminal task state behind the scenes without a new valid
  work item.

### 9.6 Error and recovery states

Errors are translated into impact and choice:

> I couldn’t finish the release check because GitHub access expired. Nothing
> was merged. Reconnect GitHub, and I can continue from the last completed
> check.

Requirements:

- distinguish transient/retrying, blocked-on-user, and terminal outcomes;
- state what did and did not happen;
- offer Retry, Reconnect, Change approach, or Stop only when applicable;
- preserve the user's message and any completed artifacts;
- put actionable terminal failures in Needs you;
- place logs and provider errors under Technical details; and
- show a reconnecting banner when the message stream is interrupted, without
  falsely declaring the underlying work failed.

### 9.7 Empty and filtered-empty states

- No conversations: use the first-time invitation, not “No chats.”
- No Today items: omit the rail on desktop and show no badge on mobile.
- Empty conversation search: **“No conversations match.”** Preserve the query
  and offer clear search.
- An empty Plan, Task, Run, or Schedule page retains its current purpose-built
  empty state and manual creation path. Homepage emptiness does not alter those
  surfaces.

## 10. Concierge behavior contract

### 10.1 Intake

- Acknowledge the user's goal in their language.
- Ask at most one blocking question at a time.
- Prefer a stated reversible default over a questionnaire.
- Do not create visible plan/task clutter for a request that can be answered
  directly.
- When durable work is needed, narrate the approach before dispatching it.

### 10.2 Delegation

- The concierge chooses and coordinates specialists; the user is not asked to
  select a persona unless they explicitly want control.
- Specialists receive the relevant user intent, constraints, permissions, and
  approved context—not the entire unrelated conversation history.
- Parallel work is grouped into named workstreams meaningful to the user.
- The concierge remains responsible for conflicts, retries, and determining
  when specialist output is sufficient.
- Home never creates separate specialist conversation threads or unread counts.

### 10.3 Progress

- Update the receipt at meaningful milestones, not on every agent event.
- Notify the user only for a required decision, material risk/change, failure
  that needs them, or useful completed outcome.
- If strategy, scope, risk, cost, or timing changes materially, state the change
  and why.
- “No action needed from you” must be explicit when activity is visible but no
  response is required.

### 10.4 Synthesis

The concierge must not forward specialist responses verbatim by default. It
must reconcile disagreement and return:

1. the answer or outcome;
2. the strongest supporting evidence;
3. material uncertainty or unresolved risk;
4. what changed or was produced; and
5. the next action, or “Nothing else needed from you.”

Attribution such as “Security review” is useful when it establishes expertise
or provenance. Persona names are optional detail, not the information
hierarchy.

## 11. Today rail

Today is a derived, user-scoped pulse—not a second task list.

### 11.1 Sections and ordering

1. **Needs you** — unresolved explicit actions owned by the current user.
2. **In motion** — active outcomes with a meaningful recent milestone or next
   update. Maximum three.
3. **Ready** — completed outcomes/artifacts not yet acknowledged. Maximum two.

Within Needs you, order by impact/severity, then oldest waiting time. Within In
motion and Ready, order by most recently meaningful update. Never order by raw
event volume.

### 11.2 Inclusion rules

An item represents one conversation/outcome, even if it has many plans, tasks,
or runs. Include only if the current user can access every disclosed detail.

- Needs you requires an explicit action type, prompt, destination, and unresolved
  state.
- In motion requires currently active underlying work or an acknowledged
  concierge action in progress.
- Ready requires a meaningful user-facing deliverable or conclusion, not merely
  a successful internal run.

Completed, cancelled, acknowledged, superseded, muted, or stale items fall out
of Today according to section rules. If an outcome qualifies for Needs you, it
must not also appear under In motion.

### 11.3 Item content

Each item shows outcome title, one-line state, and at most one primary action.
It may show a trustworthy next-update time or waiting duration. It must not show
task/run IDs, model names, token counts, cost, branches, acceptance-criteria
fractions, or specialist avatars in collapsed form.

Desktop hides the rail when all sections are empty. Users can collapse it and
the preference persists. Mobile badges count Needs you only, never all
activity.

## 12. Default-path disclosure rules

Progressive disclosure governs what the concierge conversation shows by
default; it does not govern whether operational pages are accessible. A user
may jump from any layer directly to Plans, Tasks, Runs, or Schedules through
primary navigation.

Use the following depth within the concierge path:

| Layer | Surface | Content |
|---|---|---|
| 0 | Home transcript/Today | Outcome, next action, expectation, synthesized result |
| 1 | Expanded receipt/details | Workstreams, milestones, specialist roles, artifact/evidence links |
| 2 | Direct operational surface | Plans, tasks, canonical states, owners, dependencies, runs, schedules |
| 3 | Technical details | IDs, models, providers, prompts where permitted, events, logs, branches, tokens, cost |

Content may move upward only when necessary to explain impact, secure informed
consent, or resolve a failure. Cost moves to Layer 0 before the user confirms a
spend that exceeds policy. A security-relevant permission or external side
effect is never hidden behind disclosure.

### 12.1 Must not appear on home by default

- aggregate token-in/token-out or cost-today telemetry;
- global Running/Review/Blocked/Queued/Completed stat tiles;
- task, plan, run, session, or occurrence IDs;
- model/backend/provider selectors;
- persona roster or one status row per specialist;
- branches, worktrees, shell commands, raw logs, stack traces, or event feeds;
- acceptance-criteria counters unless directly relevant to a requested review;
- a kanban/table of all plans or tasks;
- pause/stop/open controls for every active run;
- empty panels for categories with zero items; or
- “live,” pulsing, or streaming decoration without user value.

## 13. Relationship to existing surfaces

### Existing chat/runs

- Existing `goal = '<chat>'` runs and `agent_messages` remain the conversation
  and streaming foundation where compatible.
- The current Runs index remains directly accessible from primary navigation
  with its existing inspection and control UX. Home becomes the default place
  to start a concierge conversation; Runs remains the place to inspect chats,
  agent runs, parent/child relationships, events, and technical state.
- Existing conversation URLs and `/chat` redirects remain valid.
- Child/specialist runs remain inspectable from expanded details and the Runs
  surface.
- The homepage must distinguish a durable concierge conversation from a finite
  implementation run in labels, navigation, and lifecycle behavior.

### Plans and tasks

- The concierge may create/link plans and tasks as execution requires.
- Conversation copy refers to the outcome; entity creation is acknowledged only
  when it helps orientation or the user asks.
- Plans and Tasks keep their existing state machines and detailed CRUD/control
  surfaces, their direct primary-nav links, and their current information
  density.
- A user can open the exact related plan/task from receipt details, and return
  to the originating conversation.

### Schedules

- Recurring outcomes may surface in Today when they need input or produce a
  result.
- Schedule configuration and occurrence history remain directly accessible in
  Schedules with their current deep-dive UX.

### Navigation migration

- `/` becomes the concierge homepage.
- The primary header keeps Home, Plans, Tasks, Runs, and Schedules visible on
  desktop; mobile exposes the same destinations individually in its navigation
  drawer.
- Direct links to `/plans`, `/tasks`, `/runs`, and `/schedules` continue to work
  and render the current deep-dive experiences.
- If the current aggregate operations Overview remains as a separate surface,
  its route and placement are an implementation decision; it must not displace
  any of the four required operational navigation links.

## 14. Functional requirements

### P0 — required for initial release

- **FR-01:** `/` renders the authenticated user's concierge start page.
- **FR-02:** A user can create a conversation and send the first message from
  home without selecting a plan, task, persona, model, or backend.
- **FR-03:** The first message is durably persisted before/while navigating and
  is never duplicated or lost.
- **FR-04:** The conversation streams persisted user/concierge messages and
  recovers cleanly after refresh or connection loss.
- **FR-05:** The user can send text, attach supported files, stop an active
  concierge turn, and retry a failed send.
- **FR-06:** Home shows recent user-accessible conversations and opens the most
  recent unresolved conversation by default.
- **FR-07:** Conversation titles are human-readable outcomes and can be renamed
  and archived.
- **FR-08:** Specialist work appears as one outcome-level delegation receipt
  that updates without producing one transcript item per event.
- **FR-09:** Receipt expansion exposes workstreams and deep links; raw technical
  details remain a separate disclosure.
- **FR-10:** Today implements the inclusion, deduplication, ordering, cap,
  acknowledgement, and empty rules in section 11.
- **FR-11:** Needs you items deep-link to the exact prompt/action and can be
  resolved from home when the action is safe to present there.
- **FR-12:** Desktop primary navigation directly exposes Plans, Tasks, Runs, and
  Schedules; mobile navigation exposes the same destinations individually.
  Their current deep-dive UX and deep links remain valid.
- **FR-13:** The concierge provides outcome-level synthesis for completed and
  failed delegated work.
- **FR-14:** Irreversible, external, sensitive, or policy-threshold actions use
  explicit confirmation with impact stated before execution.
- **FR-15:** First-time, quiet, active, needs-input, ready, reconnecting, failed,
  permissions, empty, and filtered-empty states meet section 9.
- **FR-16:** The core create/message/respond/approve/stop/recover flow works by
  keyboard and at 320 px CSS viewport width.
- **FR-17:** Home is user-scoped and does not leak conversations, attention
  items, artifacts, or work metadata across users.

### P1 — follow immediately

- **FR-18:** Contextual artifact workbench with one artifact, return path, and
  conversation-linked comments/actions.
- **FR-19:** User-controlled Today collapse preference and conversation mute.
- **FR-20:** Search spans conversation titles/messages and permitted underlying
  work, with results labeled by layer.
- **FR-21:** Trustworthy next-update estimates based on supported orchestration
  milestones; absent when the system lacks confidence.
- **FR-22:** Home notification/read state stays consistent across web refreshes
  and supported messaging channels.

## 15. Data and API implications (product level)

Implementation should reuse current runs/messages/events rather than fork a
second chat system. The product needs these read/write capabilities, regardless
of final endpoint design:

1. **Homepage read model:** current concierge, recent conversations, selected
   conversation summary, Today sections, unread/acknowledgement state, and
   authorization-safe destination links in one bounded initial load.
2. **Conversation lifecycle:** create, title/rename, archive, mute, list, send,
   attach, stream, stop current turn, and retry failed send.
3. **Outcome linkage:** a durable way to associate a concierge conversation
   with zero or more plans, tasks, parent/child runs, schedules, and artifacts
   without requiring one plan per conversation.
4. **Delegation projection:** an outcome-level projection that folds child-run
   and task events into workstreams, milestones, attention reason, last
   meaningful update, and current expectation. It must be reconstructable after
   restart and idempotent under duplicate events.
5. **Attention records/projection:** explicit user owner, action type, prompt,
   severity/impact, status, created/resolved/acknowledged timestamps, and
   destination. “Blocked” alone is insufficient to infer Needs you.
6. **Ready acknowledgement:** persist seen/acknowledged state per user so Ready
   does not reappear indefinitely or disappear for another user.
7. **Synthesis:** persist the concierge's user-facing summary as a normal
   message/artifact, not only as ephemeral generated UI text. Record source
   entity links and freshness without exposing hidden reasoning.
8. **Access control:** every aggregate must apply the same user/repository
   authorization as entity pages before counts, titles, snippets, or links are
   returned.

The API should return canonical domain states and let the presentation layer
map them to human language. It must not infer user ownership from assignee or
persona name alone. Today queries need bounded result sizes and should avoid
N+1 entity/event scans.

## 16. Accessibility and responsiveness

- Meet WCAG 2.2 AA for contrast, focus visibility, semantics, labeling, target
  size, motion, and keyboard access.
- Status may use color only as a redundant cue; include text and/or icon.
- New streaming content does not unexpectedly move keyboard focus or force
  screen-reader users back to the bottom. Announce meaningful concierge
  messages and decisions through a polite live region; do not announce every
  receipt tick.
- Provide a visible “Skip to latest message”/jump affordance when appropriate.
- Composer, receipt disclosure, Today items, menus, structured approvals,
  workbench, stop, and retry are fully keyboard operable.
- Focus returns to the invoking control when a sheet/workbench closes.
- Respect reduced motion. Updating receipts use no continuous animation.
- Text supports 200% zoom without clipping, overlap, or horizontal scrolling in
  the core conversation.
- Desktop rails collapse progressively; mobile remains single-column. Test at
  320, 375, 768, 1024, 1280, and 1440 px.
- Dates, times, costs, and durations use locale-aware accessible labels.

## 17. Trust, safety, and privacy

- The concierge states consequential assumptions before acting and separates
  completed actions from intended actions.
- External side effects and irreversible/high-impact actions follow existing
  permission and confirmation policy. The confirmation names the target and
  consequence.
- Stop must halt the active concierge turn promptly and offer scoped choices
  for already-delegated work; stopping the conversation must not silently
  cancel unrelated runs.
- The UI must never expose chain-of-thought. It may show concise rationale,
  evidence, tool outcomes, provenance, and technical logs where authorized.
- Specialist context is minimized to the request. Private content from another
  conversation/user is not included merely because the same concierge is used.
- Attachments display destination/scope before consequential sharing with an
  external provider.
- Generated summaries link to source artifacts/entities where possible and
  communicate uncertainty. A synthesis must not claim all checks passed when a
  specialist failed, timed out, or was skipped.
- Operational detail is always directly reachable for audit by an authorized
  user.
- Cost/token telemetry is excluded from home by default but remains available
  under usage/technical details; spend requiring consent is surfaced before
  execution.
- Today content follows current user access and is removed promptly when access
  is revoked.

## 18. Success metrics and instrumentation

### 18.1 Primary outcomes

- **First useful request rate:** percentage of new signed-in users who send a
  substantive concierge request within their first session.
- **Time to first request:** median time from homepage load to first send;
  target < 60 seconds for configured workspaces.
- **Concierge completion loop:** percentage of delegated conversations that
  reach a synthesized Ready outcome or explicit user-approved stop.
- **Attention resolution time:** median time from Needs you creation to user
  response, segmented by action type.
- **Status self-service:** reduction in repeated “what is happening?” queries
  without a reduction in comprehension or trust survey scores.
- **Healthy path mix:** concierge/home handles approximately 80–95% of
  interaction starts while 5–20% continue to use Plans, Tasks, Runs, or
  Schedules directly. This is a planning assumption and diagnostic range, not
  a quota that justifies making operational surfaces harder to reach.
- **Operational task success:** users entering a direct surface can complete
  representative inspection/control jobs with no regression from the current
  UX.

### 18.2 Guardrails

- failed/duplicated/lost first messages;
- accidental duplicate conversations or delegations;
- user-cancelled actions after a misunderstood assumption;
- false or stale Needs you/Ready items;
- receipt-to-underlying-state reconciliation errors;
- stop latency and stop-scope mistakes;
- receipt/detail expansion and contextual deep-link rates (high rates may mean
  the home summary is too vague);
- direct Plans/Tasks/Runs/Schedules visit share and task success, segmented by
  entry from primary navigation versus conversation context;
- accessibility defects and mobile composer abandonment;
- unauthorized aggregate/detail access attempts; and
- user-reported surprise about cost, side effects, or specialist activity.

### 18.3 Events

Instrument, with IDs pseudonymized where analytics leaves the product boundary:

- `concierge_home_viewed` (first_time, viewport class, Today section counts);
- `concierge_prompt_sent` (new/continuing, attachment boolean, suggestion used);
- `conversation_created`, `conversation_opened`, `conversation_archived`;
- `delegation_receipt_created`, `delegation_receipt_expanded`,
  `technical_details_opened`;
- `today_item_shown`, `today_item_opened`, `today_action_resolved`,
  `today_item_acknowledged` (section and action type);
- `operational_surface_opened` (surface, source: primary_nav/contextual_link,
  viewport class);
- `concierge_turn_stopped`, `delegated_work_stop_scope_selected`;
- `artifact_workbench_opened`, `artifact_action_submitted`; and
- `conversation_stream_reconnected`, `message_send_retried`.

Do not log message bodies, attachment contents, prompts, credentials, or raw
agent output to product analytics.

## 19. Rollout and migration

### Phase 0 — instrumentation and projections

- Establish conversation/outcome linkage, Today semantics, acknowledgement,
  and reconciliation monitoring behind a feature flag.
- Measure current homepage-to-chat/task/run behavior as a baseline.
- Seed/configure one default concierge identity.

### Phase 1 — opt-in beta

- New homepage available to internal users and selected workspaces.
- Plans, Tasks, Runs, and Schedules remain visible in primary navigation and
  unchanged at the page level throughout the beta.
- Compare first-request success, attention resolution, error rates, contextual
  expansion, operational-surface traffic, and operational task success against
  the current start page.

### Phase 2 — default with escape hatch

- Make concierge home the default `/` for eligible workspaces.
- Preserve all existing entity URLs, bookmarks, browser history, and APIs.
- Offer a temporary “Use operations overview as start page” setting for power
  users during validation. The setting changes the start route only; it never
  changes primary-navigation access to operational surfaces.

### Phase 3 — stabilize the dual-path IA

- Keep Home, Plans, Tasks, Runs, and Schedules as the stable product navigation.
- Retire the temporary start-page preference only after the concierge homepage
  meets success and guardrail thresholds. Keep any separate operations Overview
  at a stable documented route if retained.
- Use path-mix telemetry to improve summaries and contextual links, not to hide
  or phase out direct operational destinations.

Existing chat runs are listed as prior conversations when they satisfy access
and identity rules. They are not rewritten or merged. Chats lacking a reliable
title use a safe generated title with an option to rename. Existing active work
without a conversation remains visible in Plans, Tasks, Runs, or Schedules; it
enters Today only when it can be grouped into a truthful outcome and meets
section 11.

Rollback is a routing/navigation flag change. No existing entity or message may
depend on the new homepage remaining enabled.

## 20. Acceptance criteria

### IA and first use

- [ ] `/` opens the concierge homepage for an enabled user.
- [ ] Desktop primary navigation visibly contains Home, Plans, Tasks, Runs, and
  Schedules; each destination opens with one navigation action.
- [ ] Mobile navigation lists Home, Plans, Tasks, Runs, and Schedules as
  separate destinations without nesting them under a generic work category.
- [ ] A first-time user sees the invitation, no empty dashboard, and no more
  than three example asks.
- [ ] The user can send a first request without selecting internal entities or
  agent configuration.
- [ ] Refresh/navigation cannot lose or duplicate the first message.

### Conversation and orchestration

- [ ] One stable concierge identity acknowledges, delegates, asks, and
  synthesizes across all homepage conversations.
- [ ] Specialist activity is represented by one updating outcome-level receipt,
  not separate home threads or event messages.
- [ ] The collapsed receipt shows outcome progress, expectation, attention
  state, and disclosure; expanded details expose workstreams and evidence.
- [ ] Completed delegated work returns a persisted synthesis with outcome,
  evidence, uncertainty, deliverables, and next action.
- [ ] A user can stop the current turn and choose the scope of delegated-work
  cancellation without affecting unrelated work.

### Today

- [ ] Needs you contains only explicit unresolved actions owned by the current
  user and deep-links to the exact decision.
- [ ] An outcome appears at most once across Today sections.
- [ ] In motion and Ready use outcome-level grouping and enforce 3/2 caps.
- [ ] Acknowledged, resolved, inaccessible, cancelled, superseded, and expired
  items leave Today according to the specified rules.
- [ ] Empty Today is omitted on desktop; mobile badge count equals unresolved
  Needs you only.
- [ ] Today and the expanded receipt reconcile with underlying canonical state
  after refresh, duplicate events, and process restart.

### Default-path disclosure and trust

- [ ] None of the prohibited default-home content in section 12.1 appears in
  the initial transcript, header, conversation rail, or Today rail.
- [ ] The homepage reveals plans, tasks, runs, logs, usage, and technical IDs at
  the specified contextual depth, while Plans, Tasks, Runs, and Schedules stay
  independently accessible from primary navigation regardless of conversation
  state.
- [ ] Consequential assumptions, material scope/cost/timing changes, and
  external or irreversible effects are surfaced before action when required.
- [ ] Errors state impact, confirm what did not happen, preserve completed work,
  and provide an applicable recovery action.
- [ ] No chain-of-thought or cross-user information appears at any layer.

### Responsive quality

- [ ] Core flows pass keyboard-only and screen-reader testing.
- [ ] Meaningful messages/decisions are announced without announcing every
  progress update.
- [ ] The layout works without clipping at the specified viewport widths and at
  200% zoom.
- [ ] Mobile supports start, send, attach, reply, approve, stop, recovery,
  Today, detail expansion, and return to conversation.
- [ ] The optional workbench is dismissible, preserves conversation state, and
  becomes a full-screen drill-in below 1024 px.

### Measurement and rollout

- [ ] Primary, guardrail, and reconciliation metrics are available before the
  beta expands.
- [ ] Analytics contain no message or attachment content.
- [ ] Existing `/plans`, `/tasks`, `/runs`, `/schedules`, and legacy chat links
  remain valid.
- [ ] Existing Plans, Tasks, Runs, and Schedules page-level inspection and
  control flows show no functional regression in representative user tests.
- [ ] The feature can roll back without schema/data rollback or loss of messages
  and work.

## 21. Open questions

These do not block product direction, but must be resolved before implementation
of the affected requirement:

1. Is the default concierge globally named, workspace-configurable, or
   user-selectable? The homepage requires one stable identity after selection.
2. Does one conversation map to one durable top-level chat run, or should a
   longer-lived concierge thread contain explicit outcome segments? This PRD
   recommends one conversation per coherent outcome for retrieval and grouping.
3. What authoritative signal identifies “needs this user” across approvals,
   blocked tasks, integration failures, and review requests? Assignee alone is
   not sufficient.
4. What constitutes acknowledgement for Ready: opening the item, opening its
   artifact, replying, or an explicit Dismiss action? Default recommendation:
   opening marks seen; explicit Done/dismiss or seven-day expiry removes it.
5. Can v1 produce trustworthy time estimates? If not, ship milestone-based
   expectations and omit clock times.
6. Which existing conversation types qualify for migration into the homepage
   rail, and how are shared/team conversations distinguished from private ones?
7. On mobile, should direct operational destinations appear in the first drawer
   group or a persistent bottom navigation? They must remain individually named
   and no more than one navigation reveal plus one selection away.
8. Which artifact types earn the P1 workbench, and which actions can be safely
   completed inline versus requiring their existing detail page?

## 22. Launch copy reference

| Moment | Copy |
|---|---|
| First use | **What would you like to move forward?** |
| Support | Tell me the outcome. I can plan the work, bring in specialists, and return with decisions and results. |
| Composer | **Ask [name] anything…** |
| Active receipt | **Work is moving** |
| No attention | **No action needed from you** |
| Quiet return | **Nothing needs you right now.** |
| Needs input | **I need your call on one thing.** |
| Ready | **Ready for you** |
| Detail link | **See details** |
| Plan link | **View plan** |
| Task link | **View task** |
| Run link | **Inspect run** |
| Schedule link | **View schedule** |

Copy must remain calm, direct, and specific. Avoid “AI-powered,” “magic,”
“autonomous workforce,” anthropomorphic emotional claims, and celebratory filler.
