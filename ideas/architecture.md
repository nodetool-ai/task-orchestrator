# Technical Architecture

A structured plan-graph system for AI-collaborative software development. Models get faster + longer context, so this becomes feasible.

## Scope

Initial design targets:
- New codebases or greenfield work
- Single-repo as primary; multi-repo supported, not central
- Request-response systems (web, API, services)
- Low-to-medium-risk work; high-risk uses same model with stricter policies

Compatible but not v1:
- Multi-repo coordination across teams
- Stateful change (migrations, blob/asset transforms)
- Realtime, embedded, timing-critical systems
- Legacy codebase migration

The meta-layer covers more than it solves. Security, performance, supply chain — surfaced as patterns and highlights, not as separate subsystems.

## Data model

### Plan
Top-level intent. Approved before any code is written.
- `goal` — plain language statement
- `scope` — in / out / deferred
- `state` — proposed | approved | in-progress | complete | superseded | abandoned
- `phases` — ordered list
- `radius` — union of phase radii
- `git_locus` — how this plan maps to version control (see below)
- `freshness` — current | stale | needs-reassessment, with timestamp of last validation
- `history`, `comments`

### Phase
Subdivision of a plan, roughly "a thing that ships and could be tested independently."
- `parallelism_style` — sequential | parallel | fork-join | pipeline
- `tasks` — set, with edges between them
- `convergence_point` — what must hold before next phase starts
- `state`, `history`, `comments`

### Task
Unit of work, roughly one focused commit's worth — but recursive: a task can decompose into subtasks when work turns out to be compound.
- `description` — what this task does
- `code_radius` — files, symbols, regions touched (likely / maybe / read-only)
- `behavior_radius` — surfaces affected (user-facing, API, performance, operational, data, security), with confidence levels
- `test_commitments` — tests added / modified / deleted with intent
- `user_test_required` — when automated tests are insufficient; task stays open until result is recorded
- `user_perspective` — relevant feedback, research, advocacy notes
- `mood` — lightweight emotional weight from participants (see Mood layer below)
- `executor` — human or agent
- `state` — proposed | approved | ready | in-progress | decomposed | complete | failed | superseded
- `subtasks` — child tasks, when decomposed
- `commits` — links to actual git commits produced
- `history`, `comments`

When a task decomposes, its state becomes `decomposed`, work moves to its children, and completion is satisfied when children are. Decomposition can happen at plan time (planner or human), during execution (agent discovers compound work), or in response to other plans shipping (reassessment reveals new structure).

The plan/phase/task hierarchy is partially recursive: phases contain tasks, tasks may contain subtasks, subtasks may contain their own subtasks. Soft bounds on depth — the leaf criterion is "small enough to commit, big enough to be meaningful." Persistent deep decomposition without progress is a stuck-state signal, not a feature.

### Test
First-class entity, not just code-with-extra-meaning.
- `id`, `location`
- `state` — passing | failing | skipped | flaky | deleted
- `created_by_task`, `modified_by_tasks`
- `assertion_kind` — behavior | implementation-detail | integration | edge-case
- `history`

### Edges (between tasks)
- `depends_on` — hard sequential dependency
- `soft_dependency` — easier-if, not blocking
- `parallel_safe_with` — explicitly safe to run concurrently
- `conflicts_with` — cannot run concurrently (computed from radii or declared)
- `supersedes` — replaces a prior task, preserving history
- `parent_of` / `child_of` — decomposition
- `triggers` — completion creates / activates the target
- `related_to` — informational only

### Cross-references
Tasks ↔ commits ↔ code regions ↔ tests ↔ user feedback ↔ Linear/Jira tickets (when relevant). Bidirectional. Anchored to symbols/AST nodes, not line numbers.

## Architecture

### Planner
Generates plans from intent + full repo context.

Responsibilities:
- Decompose into phases and tasks
- Predict code radius (commitment) and behavior radius (forecast)
- Identify parallelism opportunities
- Pre-detect conflicts across proposed tasks
- Propose test commitments
- Surface uncertainty explicitly
- Advocate for user perspective when relevant feedback exists

The planner produces structured artifacts plus a natural-language summary. Humans read the summary; the orchestrator reads the structure.

### Orchestrator
The higher-level entity. Holds the schedule, mediates between plans, surfaces conflicts.

Responsibilities:
- Static collision detection from declared radii (across all in-flight plans)
- Resource locking (code regions, schemas, external resources, individual tests)
- Schedule generation: ready set, parallelism dispatch, convergence
- Resource budgeting (rate limits, environments)
- Cross-plan pattern surfacing at scheduling time
- Plan revision handling: when actual radius exceeds declared, pause and renegotiate

Roughly analogous to a database transaction manager or build system executor.

### Agent(s)
Execute tasks within their declared sandbox.

Constraints:
- Honor declared radius — escalate if implementation requires exceeding it
- Honest reporting: what was done, what wasn't, deviations from plan
- Cooperative protocol: request expansion, accept rejection, abandon gracefully
- Operate against test commitments as the definition of done

Multiple agents may run in parallel when the orchestrator schedules parallel-safe tasks. Single agent is the common case when one fast model saturates demand.

### Verification layer
- Tests run when their tasks complete
- Plan-code correspondence check: did the diff stay within declared radius?
- Coverage analysis: are the test commitments actually covering what the code changed?
- Behavior radius validation (where possible): did production signals match predictions?

### Pattern detection
Continuous queries against the plan graph and history.

Surfaces:
- Thrash zones (areas modified across many recent plans)
- Bandage clusters (semantically similar bug fixes recurring)
- Escalating workarounds (defensive code growing across plans)
- Test erosion (deletions, skips, brittleness patterns)
- Drift accumulation (small changes shifting architecture without decision)
- Stalled work (in-progress for too long, no commits)
- Calibration drift (planner's predictions diverging from reality)
- Trust drift (rate of plans shipped without human engagement, trending over time — the normalization-of-deviance failure mode)
- Usage signals (plans whose code has been exercised in production vs. plans that shipped and were never really used; production usage and incident history as quality data fed back into pattern recognition)

Output: refactor recommendations, weekly digests, agent-introspection answers.

## Key mechanisms

### Two-variant blast radius
- **Code-touched**: structured (files, symbols, regions, with confidence tiers). Mechanically checkable. Enforceable contract. Drives orchestrator collision detection.
- **Behavior-affected**: structured by behavior type, with confidence. Predictive forecast, not commitment. Drives human attention routing and risk classification.

The combination resolves both: small-diff/large-behavior changes (config flip on critical path) get flagged; large-diff/small-behavior changes (boilerplate, mechanical refactor) get fast-tracked.

### Test locking
Granularity = individual test, not test file. Two plans appending different tests to the same file don't conflict. Modifications to existing tests do. Shared fixtures are separately addressable.

### Plan-code correspondence
Every commit links to a task. Diff content checked against task's declared radius. Discrepancies surface as review items, not silent drift.

### Calibration loop
Predicted radius compared to actual radius after execution. Persistent over- or under-prediction recorded. Future predictions adjusted. Track record visible to humans for trust calibration.

### Radius-keyed history
The declared radius doubles as a lookup key into the closed-plan archive. At draft time, the planner surfaces ancestor plans whose radii overlap the current one — institutional memory expressed conversationally, not template inheritance. Cheap mechanically: radius overlap is regular and accurate in monorepos where work in the same region tends to share shape. Surfaces local risk patterns (bandage clusters), calibration noticings (typical task counts in this area), and negative knowledge (paths previously considered and rejected, with reason).

### The contract layer
Not a separate component — a property the system enforces.
- Honest uncertainty disclosure (mandatory in plans)
- Track-record visibility (queries against history)
- Error surfacing (failures in their own state, not hidden)
- Productive pushback (AI flags concerns, even unprompted)
- Repair flows (revert, replan, escalate — all structured)

Concerns carry weight asymmetrically. By default they are *advisory*: surfaced for consideration, dismissible at lock time with the dismissal recorded. Designated humans (typically area owners) can mark theirs as *blocking* — unable to be dismissed without resolution or an authorized override. The AI never blocks. Personas can raise concerns at the highest visibility, but the authority to bind belongs to humans. Blocking is rare by design; if half of all concerns are blocking, the signal degrades into sign-off theater.

### Mood layer
Lightweight emotional weight attached to tasks, aggregating up the plan tree. Captures felt sense — strain, confidence, energy, concern — that exists before anyone can articulate why.

Properties:
- **Low-friction expression**: single tap or click, three to five rough dimensions. Friction kills honesty.
- **Anonymous by default**: source not attributed in default views. Anonymous flagging always available.
- **Aggregates up the tree**: tasks → phases → plan, surfacing the *shape* of mood (uniform low concern, one strained phase, energy dropping over time) not just averages.
- **Decays aggressively**: old mood data fades. Recent signal dominates; long-term emotional records don't accumulate.
- **Decoupled from accountability**: flagging is signal only, not request, complaint, or vote. The moment flagging triggers consequences, people stop flagging honestly.
- **Visible within the team, aggregate-only above**: people working on a plan see each other's mood; managers above see aggregates only.
- **AI participation, epistemically honest**: the AI can flag things too — "more uncertainty than I'm reporting as confident," "constraints pulled in conflicting directions" — but framed as observations, not feelings in the human sense.

The mood layer surfaces felt sense as a first-class signal. It doesn't force decisions; it gives the work a vibe that participants can sense and respond to.

The failure mode to design against: vibes-as-management-tool. If mood data feeds into performance reviews, gets watched by leadership, or otherwise becomes weaponized, the signal degrades to what people feel safe performing. Structural protections (anonymity, decay, aggregate-only views above team level) are not optional — without them the layer turns into surveillance and the data goes bad.

## Plan-branch duality

The plan graph and the version control graph are dual representations of the same underlying reality. Every plan node has a `git_locus` describing how it maps to git.

### Locus types

- `branch:<name>` — plan owns a real branch. Default for normal feature work.
- `branch-tree:<root>` — plan owns a tree: one parent branch, child branches per phase. Default for multi-phase plans.
- `virtual:tag-range:<start>:<end>` — plan corresponds to a commit range on an existing branch (usually main). For changes too small to deserve a real branch.
- `virtual:metadata` — plan reconstructed by querying commits with matching `plan-id` metadata. Cheapest in git terms.

### Granularity rules

| Plan size / shape | Default locus |
|---|---|
| Single substantial feature | `branch` |
| Multi-phase, ships in pieces | `branch-tree` |
| Trivial change (instant mode) | `virtual:tag-range` or `virtual:metadata` |
| Exploratory | `branch` with `exploratory` flag (cannot merge to main without promotion) |

### Promotion and demotion

- Virtual → real branch (promotion) when work grows beyond initial estimate. Possible only while work is unmerged.
- Real → virtual (demotion) when work turns out smaller than expected. Branch merges and is virtualized.
- Both transitions are atomic: plan graph and git state update together.

### Synchronization

The orchestrator is the source of truth for both graphs. Git operations go through it. Out-of-band git operations (manual rebases, force pushes) trigger reconciliation: the system detects the drift and updates the plan graph to match. Aggressive reconciliation is preferred over constraint — teams will do git operations outside the system regardless.

### Failure modes

- Squash merges destroy commit-to-task linkage; either constrained for plan-bearing branches or rewritten with metadata preservation.
- Cross-cutting plans that span existing branches don't fit the tree cleanly; tolerated as edge cases with cross-link edges.
- Branch identity outlives plan identity through supersession; tracked as temporal layering on the branch's plan history.

## Plan freshness

Plans declare radius based on the codebase at approval time. As other plans ship, the underlying assumptions can become stale.

### Drift detection

The orchestrator watches for changes in regions intersecting any in-flight plan's radius. Triggers for reassessment:

- A function the plan reads has been modified
- A symbol in the plan's read-only radius has been deleted or renamed
- A new dependency was introduced into the plan's touched area
- A meta-critical region now intersects the plan's scope (was peripheral, now isn't)
- The behavior radius of another plan now overlaps with this plan's behavior radius
- Test commitments reference tests that have been deleted or substantially modified

### Reassessment outcomes

When a plan is flagged stale, the planner re-runs the radius prediction against current state and produces one of:

- **Confirmed**: claims still hold, freshness timestamp updates, no further action.
- **Updated radius**: claims have shifted but plan intent is unchanged. Orchestrator re-checks scheduling; if no new conflicts, plan continues with updated radius. If conflicts emerge, plan blocks until resolved.
- **Needs human review**: assumptions material to the plan have changed. Plan returns to `proposed` state with a diff between original claims and current reality. Human re-approves or revises.
- **Superseded by reality**: the change in the world has already accomplished what the plan was for, or made it impossible. Plan abandoned with explanation.

### When reassessment runs

- Before a plan moves from `approved` to `ready` (last check before execution)
- When the orchestrator detects drift in a watched region
- On explicit human request
- On a periodic cadence for long-lived plans (weekly check for plans that have been approved but not yet executed)

### The cost discipline

Reassessment isn't free — it requires the planner to redo work. The system avoids gratuitous reassessment: only material drift triggers it, and the planner can do an incremental check (did anything that matters change?) before a full re-prediction.

## Granularity decisions

| Concern | Granularity |
|---|---|
| Code locking | Symbol / AST node |
| Test locking | Individual test |
| Display to humans | Approximate line ranges |
| Behavior radius | By type (user-facing, API, etc.), not files |
| Plan approval | Per plan, with portfolio-level orchestrator awareness |

## Scope notes

This is the contract-mode system: low-to-medium-risk app development where humans can't and shouldn't verify every detail. High-risk regulated work needs verification-mode policies on the same model — same data structures, different approval thresholds.

---

## Future / less concrete

### Meta-layer applications (use existing structure)
- **Security and supply chain**: critical regions (auth, secrets, payment paths, dependency additions) flagged at plan time via behavior radius. Cross-plan patterns surface drift in security posture. Uses the visibility the architecture already provides.
- **Performance dimension**: behavior radius extended with performance characteristics. Cross-plan trajectory catches slow degradation no single change would flag.
- **Cost as quality signal**: aggregate execution cost per plan tracked. Bad plans cost more (retries, regenerations). Becomes a proxy for plan quality.
- **Stateful change handling**: migrations, schema changes, blob transforms get visible radius and dependency tracking through the same model — without solving live-data coordination problems fully.

### Architectural extensions
- **Effect declarations as runtime contract**: static analysis prevents writes outside declared regions, not just detects them after.
- **Speculative execution**: orchestrator runs likely-needed tasks eagerly; throws away work when bets are wrong. Worth it when execution is cheap relative to wait time.
- **Compensating actions**: when a parallel branch fails, peer branches that depended on its outcomes get adjusted automatically.
- **Plan templates from history**: after N similar plans, propose typical structure with risk areas pre-marked.
- **Cross-org pattern library**: anonymized patterns of what works / what breaks, shared across teams using the system.
- **Live behavioral preview**: ephemeral environments per plan, with hot-patching, sandboxed effects, snapshot/restore. Reviewer confirms behavior, not code.
- **Agent memory via graph**: agents query the plan graph as long-term memory across sessions, gaining persistence they don't currently have.
- **Multi-human approval routing**: plans routed to specific reviewers based on what they touch (security review for auth-touching plans, etc.).
- **Multi-repo coordination**: cross-repo task links and orchestration when work genuinely spans repos.
- **Plan portability**: open formats so plans survive tool migrations, preserving institutional memory.
- **Production lifecycle states**: plans don't fully close at merge — they stay open through staging/canary/production with rollback awareness.
