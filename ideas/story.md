# A New Way of Building Software

An attempt to take an accessible-but-rare experience — humans and AI thinking together substantively on hard problems — and make it the default mode of software development.

## The shift

Models get faster and gain longer context. Code generation stops being the bottleneck. The bottlenecks move: review, coordination, knowing what's worth building, knowing whether what was built is right.

The current PR-and-review workflow doesn't survive this. Reviewers can't read what gets generated. Auto-merge becomes the default. Quality decays in ways no single PR reveals.

The shift this document describes: humans stop working at the level of code and start working at the level of **plans**. AI handles implementation. Plans become the durable artifact that ties humans, AI, and code together.

## Plans are a conversation

A plan is not a specification handed down and executed. It's a thing to be discussed, pushed back on, revised, returned to. The value comes from the back-and-forth — direction from humans, context and elaboration from AI, with each side correcting and extending the other. Neither is in charge; both are necessary.

This means:
- Plans evolve through dialogue, not single-pass authoring
- The AI proposes, pushes back, raises concerns; the human redirects, decides, judges what matters
- Disagreement is productive — it's where the real thinking happens
- Plans stay open for revision long after initial approval; what's learned in execution feeds back
- Trust is calibrated through the conversation itself, not assumed in advance

The architecture supports this practice but doesn't substitute for it. A team that engages substantively with crude tools gets more out of them than a team that rubber-stamps with sophisticated ones. The tools matter; the practice matters more.

## The inversion

For most of software's history, code has been the central artifact. Everything else — intent, tests, docs — lived in service to it, written as supporting material around the central object. Code is the noun; the rest are adjectives.

This flips:

- **Intent** becomes the noun — the thing that's structured, versioned, reviewed
- **Tests** become the operational definition of intent — where "what we wanted" meets "how we'll know"
- **Documentation** becomes a derived view of intent and outcomes
- **Code** becomes implementation detail — necessary but no longer central, like assembly to a modern programmer

The cycle that emerges: intent generates plans, plans drive tests, tests validate code, code produces outcomes, outcomes feed back into intent. Each layer supports the others rather than competing for attention. Time on tests is no longer time stolen from code; both serve the same intent.

Each layer also gets to be what it actually is, freed from duties it shouldn't have had. Intent was load-bearing but had no structure; now it has structure. Code was structured but load-bearing for things it wasn't about (intent capture, behavioral verification, knowledge transfer); those things move to where they belong.

This is the same kind of move that earlier shifts made — assembly to high-level languages, imperative to declarative. Each demoted something that felt essential and elevated something that felt optional. Each was met with skepticism. Each turned out roughly right.

## Planning as the work

If plans are the new central artifact, planning has to be a good experience — not a chore. Most existing planning tools optimize for administrative tractability. This needs to optimize for thinking and making.

What this looks like:

- Plans start as plain-language sketches. AI proposes structure you can accept, revise, or ignore.
- Iteration is cheap. Move tasks, split, merge, revise — all one operation. Bad plans get fixed through play, not commitment.
- Tasks can decompose into subtasks when work turns out compound. What looked atomic becomes a tree; the original intent persists as the frame for the children.
- The AI is a thinking partner. It pushes back, raises concerns, proposes alternatives, surfaces blind spots.
- Blast radius and impact are visible live as the plan takes shape, not computed after.
- Comparison and remix are first-class. Side-by-side variants, take a phase from one plan and a task from another.
- Templates come from the team's real past plans, not generic forms.
- Multiple people work in a plan together — async by default, structured comments, branching for disagreements that get resolved through artifact rather than debate.
- Plans carry a mood. Participants flag felt sense — strain, confidence, concern — with a tap, anonymously by default. Mood aggregates up the tree, giving plans a vibe you can glance at. It doesn't force decisions; it surfaces what people feel before they can articulate why.
- The visual experience matters. Prose rhythm, color for the meta-layer, motion that conveys change. The aesthetics are part of the design, not an afterthought.

Plans should feel less like filing a ticket and more like sketching. If creating a plan feels like work, the system fails regardless of what's underneath.

## Scope and focus

This is not a universal solution. Trying to fit every kind of software work makes the system worse for all of it.

Initial focus:
- New codebases or greenfield work in existing ones
- Single-repo work as the primary case (multi-repo supported but not central)
- Standard request-response systems (web apps, APIs, services)
- Low-to-medium-risk work where humans can't and shouldn't verify every detail

Out of focus initially, but compatible with the model:
- Multi-repo and cross-org coordination
- Database migrations, schema changes, stateful data transformations
- Real-time, embedded, and timing-critical systems
- High-risk regulated work (uses the same model with stricter approval policies)
- Migration of large legacy codebases into the system

The meta-layer perspective covers more than it might seem. Security and supply chain concerns, performance characteristics, and other cross-cutting issues are surfaced as patterns and meta-critical highlights — not as separate subsystems. The architecture doesn't solve these, but it makes them visible at a level where humans can act on them.

## Core ideas

**Avoid the diff at all costs.** The diff was never the right surface for review. A short summary, an annotated file tree, and the ability to ask questions about a change replace 90% of what diff-reading was doing.

**Plans as first-class objects.** Not prose tickets — structured artifacts with phases, tasks, state, history, comments, and links to commits and code. A plan is the contract between human intent and AI execution.

**Talking with your app.** Small, low-risk changes happen instantly: ask, see the result, accept or reject. Larger changes become explicit plans the human approves before code is written.

**Tests as the operational definition of done.** A task commits to specific tests. The tests are what humans review at plan time. Done = tests pass. The discipline only works if tests encode intent, not implementation.

**Meta-signals over time.** Patterns across many plans matter more than any single plan. Thrash zones, bandage clusters, escalating workarounds, test erosion — these are where bugs and structural problems hide. Visible only when you watch the whole stream.

**Usage as quality signal.** Surface artifacts of quality (good README, comprehensive tests, clean structure) are now generatable at near-zero cost. What still carries information: has this been used in anger? Production runtime, incident history, real user feedback over time — these are first-class signals about plan and code quality, not just operational data about a running system.

**Refactor at the right moment.** The right time is brief and currently always missed. The system watches for it (area is quiet, tests in place, pattern is clear) and surfaces refactor plans when conditions align.

## What humans do

- Express intent in their natural register
- Review and approve plans (not code)
- Confirm test commitments capture what "done" means
- Get notified at meaningful boundaries, not per-task
- Push back when the AI's plan misses something
- Make judgment calls the AI can't: should this exist, is this the right abstraction, what does the user actually want

Humans operate at a level of abstraction they couldn't operate at unassisted. The AI is the prosthetic that makes large-system reasoning possible.

## What the AI does

- Translates intent into structured plans with full repo context
- Declares what each plan will touch (code) and what it will affect (behavior)
- Executes within declared bounds, escalating when discoveries require more
- Reports honestly: what was done, what wasn't, what's uncertain
- Advocates for the end user, not just the developer
- Surfaces patterns and concerns the human didn't ask about

The AI is asked to act like a good professional with multi-party duties — not a compliant contractor.

## The contract

The relationship between human and AI is structurally a trust-based delegation contract. The human can't verify every detail and shouldn't have to. The system functions through:

- Clear declaration of intent
- Honest disclosure of uncertainty
- Visible track record over time
- Surfaced (not hidden) errors
- Calibrated confidence
- Repair when things go wrong

Mistakes are expected. The system is built to contain, surface, and learn from them — not to prevent them through assumed competence.

## Parallel agents, made safe

Multiple agents become useful when models are cheap and fast. They become *safe* only when plans declare their **blast radius** — what code they touch, what behavior they affect — before execution.

A higher-level orchestrator reads radii across all in-flight plans, detects collisions before they happen, and schedules work. Plans with disjoint radii run in parallel. Plans that overlap are sequenced or merged. This is what current multi-agent systems lack and why they fail.

## Plans and branches

A plan corresponds to a region of the version control graph — sometimes a real branch, sometimes a tree of branches (one per phase), sometimes a virtual branch (a tag range or metadata marker) for changes too small to deserve their own branch.

The plan graph and the branch graph are dual representations of the same reality. One emphasizes intent and process; the other emphasizes code state. The orchestrator keeps them synchronized.

This means: every plan has a git locus. Every commit has a plan ancestry. The mapping is explicit at plan creation, can be promoted (virtual to real branch when work grows) or demoted (real to virtual when work turns out small), and survives plan supersession.

## Plans stay fresh

A plan's blast radius is a claim about the codebase as it exists at plan time. Other plans ship. The codebase shifts. The original claim can become stale.

Plans monitor for drift in the regions they care about. When meaningful change happens — a function the plan reads has been modified, a new dependency was introduced, a meta-critical area now intersects the plan's scope — the plan flags itself for reassessment.

Reassessment can mean: the radius is still valid, just confirm it; the radius has changed, propagate to the orchestrator; the underlying assumptions are now wrong, the plan needs human review again. The system makes drift visible rather than letting plans execute against stale snapshots.

## The user perspective

End users get a structured place in the model. Real feedback attaches to relevant tasks. The AI advocates for the user when planning. Contradictions between developer intent and user evidence become visible.

Without this, the user disappears from the loop as the loop gets more abstract. With it, the AI is a professional with duties to multiple parties, not just to whoever is typing.

## Why this works without smarter AI

Nothing here requires the AI to be more intelligent than it is now.

- Plans are easier to reason about than code (high-level pattern matching, not symbolic precision)
- Mistakes get caught at the plan level (where pattern recognition works) rather than the code level (where precision is required)
- The structure makes errors recoverable rather than fatal
- Calibration data accumulates: the system learns where the AI is unreliable and routes accordingly

If AI gets smarter, the system gets more powerful. If it doesn't, the system still works.

## The long-run shape

The artifact accumulating in this system is not just code — it's a graph of intent, work, code, tests, outcomes, and feedback, queryable across years. Asking "why does this exist," "what did users actually want," "where is our codebase getting worse" all become real queries with real answers.

Tools today have fragments of this. None have it as a coherent whole. The bet is that something with this shape becomes the substrate for software development as AI takes over implementation.

---

## Future / less concrete

- **Behavioral preview**: instead of describing what a change does, the system runs it against the live app in a sandbox and shows the behavior. The diff is replaced by the demonstration.
- **Agent introspection**: agents query the system before starting work — "what do you know about this area, what's been tried before, what should I be careful about" — gaining memory they don't currently have.
- **Plan templates that learn**: after enough plans of similar shape, the system proposes templates with typical phases, tasks, and risk areas pre-filled.
- **Cross-team learning**: patterns of what works visible across organizations, not just within one codebase.
- **Codebase health as a metric that means something**: refactor budgets, drift detection, structural debt — all currently hand-wavy, all becoming measurable.
- **Convention recalibration**: as AI does more reading, conventions optimized for human cognition (short functions, aggressive DRY) loosen where they only served humans, while ones that serve both (good names, types, tests) strengthen. Explainability stays mandatory.
- **Security and supply chain via the meta-layer**: critical regions (auth, secrets, payment paths, dependency additions) get highlighted at plan time. Cross-plan patterns surface drift in security posture. Not a separate security subsystem — an application of the visibility the architecture already provides.
- **User-test tasks**: tasks can declare "this needs real user testing" as a commitment, alongside automated test commitments. Useful for realtime systems, UX changes, anything where automated verification is insufficient. The plan stays open until the user-test result comes in.
- **Performance as a tracked dimension**: behavior radius extended to include performance characteristics, with cross-plan trajectory showing slow degradation that no single change would flag.
- **Database and stateful change**: migrations, schema changes, and data transformations get the meta-layer treatment — visible blast radius, dependency tracking, rollback awareness — without solving the harder problems of live data coordination.
- **Multi-repo coordination**: same plan model spans repos with cross-repo task links, when the work genuinely requires it.
- **Cost as a quality signal**: bad plans cost more (failed runs, retries, regenerations). Aggregate cost per plan becomes a proxy for plan quality the system tracks automatically.
- **Plan diff and comparison views**: side-by-side comparison of plan variants with AI-articulated trade-offs.
- **Plan replay**: scrub through a plan's history to see how it evolved during execution, who contributed what, where revisions came from.
- **The category question**: this isn't a code review tool, an IDE, or a project tracker. It's something new — closest to a *codebase operating system*. The naming will emerge from use.
