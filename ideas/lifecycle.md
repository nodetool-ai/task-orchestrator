# Plan Lifecycle

How a plan actually lives, from first sketch to citable artifact. This is the texture missing from the architecture and principles documents — those describe the structure and the stance; this describes the experience of working inside the structure.

## Phases as states, not gates

A plan passes through four shapes: **drafting**, **execution**, **post-execution**, and **housekeeping**. The phrasing suggests a pipeline. It isn't one. They're states the same plan can be in, and transitions are liquid. Execution can fall back to drafting when scope explodes. Post-execution can return to execution when a follow-up is actually a fix in disguise. Housekeeping observations can crystallize into new drafting weeks later.

The phases also have to be scale-sensitive. For a typo fix or a one-file rename, a drafting conversation is overhead — the contributor will route around it. The system should sense scale and offer an early exit: capture as a virtual plan after the fact, skip the ceremony. The discipline is that the AI decides when the conversation matters, not the human — because if the conversation is optional, it gets skipped on the days it's most needed.

## Drafting: a habitat for thinking

The current `draft` state is binary — not-yet-proposed. The richer version is a draft that **visibly carries its unknowns**: a plan that knows what it doesn't know yet, and remembers what it has already figured out.

Three kinds of gaps appear in a draft, each rendered distinctly:

- **Structural holes** — sections of the plan that haven't been filled. No acceptance criteria, no test commitments, no declared radius. The spine of the plan.
- **Concerns** — annotations attached to specific parts of the plan, with the persona or contributor who raised them. Sticky-note-like, threaded.
- **Open questions from the AI** — honest uncertainty about choices the human needs to make. A short thread at the top with answer/defer affordances.

Everything in a draft has **provenance**. No anonymous warnings. Every hole, concern, and question has a name or a persona attached — and that lets the contributor weigh them rather than treat them as undifferentiated noise.

### Advisory and blocking

Most concerns are advisory: surfaced for consideration, dismissible at lock time with the dismissal recorded. A few are **blocking**: raised by designated humans (typically area owners) and unable to be dismissed without resolution or override. The asymmetry that matters:

- The AI advises. Personas can raise concerns at the highest visibility, but they cannot block.
- Humans bind. Maintainers with area ownership can mark their concerns as blocking, and the plan cannot lock around them.
- Blocking is rare by design. If half of all concerns are blocking, the signal degrades into sign-off theater.

This connects the plan layer to the social structure of the project. The kernel's owner saying "wait, no" on a kernel-touching plan is not a suggestion the planner can talk you out of. Currently maintainer review depends on them spotting the right PR; making concerns blockable puts the invitation in the plan itself.

### Research markers and references

Plans don't live in the closed universe of the repo. Real planning bumps against the outside world constantly: how does another project solve this, what's the latest API of this library, is the dependency we're about to pull in still maintained.

A **research-needed marker** says, honestly: this part of the plan rests on information we don't have yet. It's different from a hole (we haven't decided) and different from a concern (someone has a worry). It's an explicit epistemic gap. Filling it can be a draft research task on the plan itself — the AI is well-suited to that work.

This implies a plan contains **three kinds of work**, not one: code changes, research and investigation, and (sometimes) user testing or verification. Today's schema is implicitly code-only.

**References** become first-class artifacts attached to plans, tasks, and concerns. A reference carries the link, a short caption, the author, the date, and ideally a snapshot or excerpt — because URLs rot and a two-year-old plan with a dead link is forensically useless. References include prior art, library evaluations, authoritative docs, existing code in the repo, related issues, and explicitly *negative* references (considered and ruled out, with reason). They make the plan legible without you — readable three months later by someone reconstructing why a decision was made.

### Drafts as pick-up-able and aging

Drafts persist across sessions. Holes, concerns, questions, and references all carry forward, which is what makes plans survive longer than a single working day. The draft becomes a returnable object — the contributor's future self can pick up where the prior self left off without re-running the thinking.

Drafts also **age**. A draft from months ago may have been written when the codebase looked different. When picked up after a long pause, the planner runs a quiet **freshness pass**: re-validates references, re-checks declared radius against current state, re-runs the persona checks. The planner reports what's changed in the world since the draft was written. This is the same freshness mechanism applied to approved plans in the architecture doc, but here it acts on drafts — where the consequences of stale assumptions are smaller and the discipline is cheaper to build.

### Locking is deliberate, not gated

A plan moves from draft to accepted by a deliberate act. The system does not require zero holes — it makes the deliberation legible. The lock confirmation lists what's unresolved: "approving this plan with 0 test commitments and 1 advisory concern." That's a different act than approving a complete plan. Gating produces ceremony; legibility produces judgment.

Blocking concerns are the exception: they cannot be locked around. Either they resolve, the raiser downgrades them, or an authorized override fires (with the override recorded on the plan).

## Codebase awareness during drafting

For NodeTool specifically, drafting is **codebase-grounded** or it's a fancier prompt. The 24-package monorepo with strict dependency order, plus sibling Python repos, plus three runtimes, makes "where does this go" and "what will this break" real questions with computable answers. A planner that doesn't know them produces generic plans; one that does becomes a teammate who has read the whole repo.

What the planner does at draft time:

- **Locates the work in the workspace graph.** Suggests likely packages, flags downstream consumers, names cross-repo touches.
- **Computes radius as a workspace-package set.** Not just files — the affected packages, the dependency closure, whether the change crosses protocol (high blast) or stays in one package (low blast).
- **Surfaces build-order hazards.** Touching node-sdk requires `npm run build:packages` before web/electron verification. Touching protocol requires building before mobile typechecks. Touching native modules requires the Electron rebuild. These are mechanical and the plan should refuse to be locked without the right checkpoints.
- **Loads CLAUDE.md / AGENTS.md by area.** Whatever packages the plan touches, those rules are in the conversation context. The planner can quote them when proposing approaches.
- **Flags UI primitive compliance.** When web/ files are touched, raw MUI imports in those files surface as a concern — migrate as part of the plan, or defer explicitly.
- **Nudges on cross-repo coordination.** When the work touches the runtime / python-bridge surface, the planner names sibling-repo dependencies. It doesn't solve coordination; it makes it visible.

## Two personas as the canonical pairing here

NodeTool's plans benefit specifically from two personas working the same draft from different angles:

- **The contributor persona** — package graph, build order, type strictness, primitive compliance, test runners. Speaks the codebase.
- **The user persona** — backwards compatibility (protocol payloads, REST endpoints, node signatures), documentation as deliverable, mental-model integrity (is this adding a fourth way to express "background work"?), naming and terminology drift, discoverability parity across CLI/web/electron.

The interesting moments are when they **disagree**. Contributor says: clean diff, types tight, fits the pattern. User persona says: fragments the mental model, public surface changed without a version bump, docs untouched. That disagreement is exactly the kind of thing a human should adjudicate — and today there's no role assigned to it, so it doesn't get spoken.

Skills make each persona checkable. The user persona claims backwards-compat watching; if a protocol-changing plan doesn't trigger its flag, the persona configuration is wrong. The contributor persona claims build-order awareness; if a node-sdk change goes through without a checkpoint flagged, same. Personas with substance can be validated; personas as tone alone degrade into ceremony.

## Execution

During execution, the agent honors the declared contract. The contract is visible to it: declared radius, test commitments, acceptance criteria. The radius is the contract that can be enforced mechanically — at the end, the worktree diff maps to packages, and the actual set is compared to the declared set.

The crucial property: when the contract is wrong, work pauses and **drafting reopens**. The agent doesn't silently expand its radius. It surfaces the discovery, gets a revised contract, and continues. Phases are revisitable; execution falling back to drafting is normal, not a failure.

## Post-execution: the closing artifact

The phase that's most underdeveloped today and most valuable to make real. When work lands, three things happen:

- **The closing artifact** — two short paragraphs. Contributor view: what landed, what surprised, what's deferred, what got learned. User persona companion note: what changed in the public surface, what docs need updating, what new behavior users will see. Honest about deviations, not a victory report. This is the plan's epitaph and the thing future readers turn to first.
- **The radius is sealed.** Declared vs actual, frozen onto the plan as historical record. This is what makes future history-peeking meaningful — the historical radii are truths, not predictions.
- **Suggestion triage.** Every AI-suggested follow-up is disposed: filed as a real plan, deferred with a date, or dismissed with reason. No silent accumulation. The act of triaging at close is the discipline that keeps suggestions from becoming a graveyard.

A one-tap **mood signal** at close, anonymous and aggregate-only, captures how the work felt. Useful only in trend, not per-plan — but the signal is captured at the moment you actually feel it.

Calibration data accumulates: did the planner's estimates hold, was the declared radius accurate, were the test commitments realistic. Not punitive — informational. Visible track record over time, used to inform future estimates and human trust calibration.

## End-of-life: done as a felt event

In most trackers, closure happens by accident — the PR merges, the ticket auto-closes, dev moves on. Nobody feels done. The work just stops. A plan system that wants to feel different needs **closure as a deliberate act**.

The closing flow is sub-two-minutes for most plans: closing artifact (drafted by the AI, edited by the human), sealed radius, suggestion triage, mood tap. Light, but real. At the end, the plan moves from active to shelved — still readable, still citable, no longer demanding anything.

### Read-only after close; fork, don't reopen

Closed plans are read-only. The temptation to reopen — "we missed one thing, let me just reopen this" — is the path back to ticket-system rot, where plans become long-running buckets of half-related work.

The structural move: **fork, don't reopen.** Starting a new plan from a closed one copies the shape (goal, task structure, radius starting point, references) and records `derived_from`. The closed plan stays sealed; the new plan inherits context cheaply. History becomes a navigable tree, not a flat list. If we got the original wrong, the new plan **supersedes** the old one with the reason recorded.

### Three honorable ends

A plan can end in three legitimate ways:

- **Done** — work landed, intent achieved, closing artifact written.
- **Abandoned** — we decided not to do this. Reason recorded. A plan abandoned with a clear "we considered it and chose not to" is a *better* artifact than a plan that quietly rotted.
- **Superseded** — the world moved past this plan. Another plan accomplished the goal differently, or the codebase changed so the plan no longer makes sense. Linked to whatever replaced it.

None of these is failure. The real failure mode is plans **silently stuck in `accepted` for months with no movement, no decision, no death**. The system should nudge after a few weeks of stillness: "this plan hasn't moved. Done? Abandoned? Still relevant?" Force the triage rather than let plans drift into a backlog graveyard.

### Outcome openness

Plans don't fully close at merge. A closed plan has a small "post-ship" section that gets filled over weeks: was it used, did it break things, did it match the original intent. For NodeTool: did the new provider get exercised in real chats, did the new node appear in user workflows, did production runtime light it up. That data is the *real* quality signal, and it arrives long after the PR merges. The plan should be where it lands.

### Decision residue and plan-as-citation

Throughout drafting and execution, decisions got made — library X over Y, defer Z, abandon W. At close, the residue surfaces as a short "key decisions" section, summarized from notes and threads. Future plans peeking back read the decisions without reconstructing them.

Once closed, a plan has a stable ID and a stable artifact. Other plans cite it. Documentation links to it. PR descriptions reference it. Over years, the citation graph between plans becomes its own valuable thing — the architecture doc's idea of "a graph of intent, work, code, tests, outcomes" made navigable.

A closed plan in this system should be a thing you'd be willing to point a new contributor at and say "read this — that's what we did, why we did it, how it actually went."

## Radius-based history peeking

When drafting a plan, the declared radius is also a **lookup key into history**. The planner quietly surfaces ancestor plans that touched overlapping packages: "the last four plans in this area shared this shape. Three of them had a step everyone forgot the first time: updating mobile types."

This is recognition, not template inheritance. The contributor can ignore, absorb, or have a conversation about it. It's institutional memory expressed through the AI — not a form to fill, but a noticing.

What it gives us cheaply:

- **Pattern recognition without ML** — radius overlap is mechanical and surprisingly accurate. Work in the same neighborhood has roughly the same shape.
- **Local risk surfacing** — "the last three plans in this area each underestimated mobile impact." Bandage clusters, scoped to the region.
- **Calibration noticings** — "plans in this area have averaged five tasks; this draft has two. Sure?" Not a rule. A noticing.
- **Negative knowledge** — "we considered approach X here twice and chose against it both times. Here's why." The paths avoided are as useful as the paths taken.

This works for NodeTool because the codebase is regular. Providers look like providers, nodes look like nodes, websocket handlers look like each other. On a less regular codebase, radius peeking would surface noise. On this one, signal.

## Housekeeping

Housekeeping is the gardening layer — the system's continuous, low-attention watch over its own data. It runs on the codebase's natural rhythms (after releases, when a package crosses a churn threshold, when a plan has been still too long) and surfaces what no single contributor will notice unprompted.

The discipline that keeps it useful:

- **Signal-first, not work-first.** Default output is *observations*, not tasks. A weekly digest, a flag on a plan, a "look at this." Observations sit lightly.
- **Promotion requires a threshold or a human nudge.** An observation becomes a task only when it has persisted long enough to matter, or when someone says "yeah, file that." Never auto-promote on the first sighting.
- **Cadence calibrated by acceptance.** If 80% of housekeeping observations get engaged with, run it more. If 10% do, run it less or differently. Don't generate noise nobody acts on.

For NodeTool, housekeeping's most valuable signals are codebase-specific:

- **Thrash zones** — packages touched by many in-flight plans simultaneously (kernel under heavy churn).
- **Bandage clusters** — semantically similar bug fixes recurring in one area (providers diverging in error handling).
- **Test erosion** — declining test counts in specific packages, skips and `xfail`s accumulating.
- **Stuck plans** — anything sitting in `accepted` past a threshold.
- **Drift in primitives compliance** — raw MUI imports growing outside `ui_primitives/` and `editor_ui/`.

Housekeeping that produces work nobody reads is worse than no housekeeping. Earning its right to generate is the discipline.

## What this is, and isn't

This is not a tracker. A tracker is a place to file tickets and watch them close.

What this is meant to be: **a habitat for thinking that survives across days and people.** The structure is what keeps the habitat from rotting. Drafts that carry their unknowns. Plans that close as citable artifacts. History that's navigable by the same coordinates the work used. Personas that push back substantively. Housekeeping that surfaces what nobody would notice alone.

The long-run accumulation is not the tasks. It's the closed plans — the graph of intent, work, decisions, and outcomes that becomes the most valuable thing the system holds. Code can be read from git. The *reasoning* lives nowhere else.

## What this accumulates into

A few shifts worth holding consciously, because they're between the lines of everything above.

**Closed plans become the project's memory.** Today the repo is code plus commit history. With this layer, it's code plus history plus a navigable graph of intent that explains the history. Three years from now, the question "why does NodeTool work this way" has an answer that doesn't depend on the original contributor still being around. That artifact compounds — a small number of well-closed plans is worth more than a much larger number of plans that just stopped. Optimizing for the citability and legibility of closure matters more than optimizing for execution throughput.

**What a contributor is shifts toward judgment.** When the AI handles much of the typing, the work that remains is taste, the call about what should exist, the noticing that something is fragmenting the mental model. The contributor's value moves up the stack. Onboarding changes downstream: the first thing a new contributor needs isn't the package graph (the AI knows it) but the project's standing trade-offs — and closed plans become exactly the teaching material for that. The system is implicitly a bet that contributors with strong taste and willingness to push back matter more than fast implementers. NodeTool, by adopting this early, is in the position to find out whether the bet pays.

**The dev system and the product converge.** NodeTool is an AI-workflow platform. Building an AI-collaborative planning system inside its repo to manage its own development creates a recursion that's worth keeping conscious: many of the concepts here (plan-as-conversation, persona-with-skills, blast radius, mood) map onto features NodeTool could one day offer to its end users. The dev tool becomes a working prototype of a product layer. That's a longer arc and might not happen — but it's visible from here, and it's part of why decisions made for the dev system are also implicit decisions about where the product wants to go.
