# MVP: The Smallest Useful Version

The architecture documents describe a destination. This describes the first step — small enough to build in weeks, useful enough to actually work in.

## The constraint

Two conditions that pull against each other:
1. Small enough to build in weeks, not months
2. Useful enough that you'd actually use it for real work

The trap to avoid: keeping all the architectural pieces and just simplifying each one. That produces a thin version of the full system that's neither small nor useful. Better discipline: pick the single most valuable mechanism and build it well, even if everything else is missing.

## The core mechanism

**Plan-as-structured-conversation that produces test commitments and a code radius, and that drives the actual code work.**

Without this, you have a regular AI coding tool. With it, you're working at the plan level, even if everything around it is primitive.

## The loop

1. You describe what you want, in plain language
2. The AI proposes a plan: intent summary, list of tasks, list of test commitments, rough code radius
3. You revise it through conversation — pushing back, redirecting, asking for reconsideration
4. When you approve, the AI executes against the plan
5. After execution, the AI reports back: tests passing, what was touched, what surprised it, what's left uncertain
6. You spot-check what you care about and ship
7. The plan persists. You can return to it, link follow-ups, leave comments

## What's required

Four properties that look cuttable but actually aren't:

**Plan as a real artifact.** Not a chat transcript. A structured document that exists separately and persists. Markdown is fine. Intent, tasks, test commitments, radius — visible and editable. If the plan lives only in conversation, you've built a chatbot with extra steps.

**Test commitments before code.** The plan must include what tests will exist when this is done, and you must agree to them before code is written. This is the discipline that turns vibe coding into something with a contract. Skip this and you're back to reviewing code or trusting blindly.

**Honest reporting after execution.** Not "I implemented X" but "I implemented X; tests pass; I noticed Y but didn't address it; I had to modify Z which wasn't in the plan." If the AI doesn't report honestly, the contract isn't being honored.

**Conversation step.** Revise the plan with the AI, don't just accept or reject. Binary approval is commissioning, not collaborating, and loses most of the value.

These four are the contract in miniature. Everything else is optimization.

## What's deliberately missing

- **No orchestrator.** Single agent, single plan at a time. Coordination is "you don't approve a second plan until the first one ships."
- **No persistent pattern detection.** Read your own plan history. Cross-plan analysis comes later when there's data to analyze.
- **No fancy branch handling.** One plan, one branch, normal git. The plan file lives in the branch.
- **No automated coverage analysis.** Declare tests, check coverage by hand.
- **No automatic radius enforcement.** AI declares; you notice in the diff if it deviated. Breaks at scale, fine at one-plan-at-a-time.
- **No persona system.** Write the system prompt yourself. Persona-with-skills matters when teams want consistency.
- **No fancy UI.** Plain text plans, conversation in a chat interface, plan file checked into the repo.

## Concrete sketch

**Format**: markdown plan files at `plans/<plan-id>.md`, structured (intent, tasks with test commitments and radius, post-execution report). Checked into the repo.

**Tool**: a wrapper around Claude Code, Cursor, aider, or similar — let the existing tool handle code execution, you handle the plan layer. Or thin standalone CLI talking to an API directly.

**Workflow**:
- `tool plan "add cancellation"` — produces a draft plan
- iterate via chat
- `tool approve <plan-id>` — locks the plan
- `tool execute <plan-id>` — runs it
- output shows what happened with reference to the plan

**Persistence**: git. Plans committed alongside code. Plan history is git history.

**Verification**: AI runs the tests it committed to. You read the report. Spot-check if you don't trust it.

Buildable in a weekend or two for the rough version. A few weeks to make pleasant.

## Don't start from scratch

OpenSpec (Fission-AI) ships much of this MVP shape already — specs in the repo, change-as-structured-artifact, AI alignment before code, tool-agnostic design. Before building from scratch, check what's already there. The extensions we worked through (contract framing, two-variant radius, cross-plan patterns, mood, personas, background gardening) probably fit better as additions to a working foundation than as the seed of yet another tool. The category is being built; participate in it rather than restart it.

## What you want to learn from using it

1. Does the plan-conversation actually feel different from current AI coding tools? If it feels like the same thing with extra steps, the structural shift isn't pulling its weight.
2. Do test commitments hold under real use? Do you actually approve plans on the basis of "yes, those tests would mean it's done"? Or do you skim?
3. Does honest post-execution reporting happen? Or does the AI tend to say "done!" and you have to dig?
4. What feels missing first? The most valuable signal — the gap tells you what to build next.
5. Where does it break down? Probably some failure mode you didn't anticipate.

## Discipline

Use it for real work for at least a month before drawing conclusions. Not demos — actual features in actual projects. Keep notes on what was painful, what was missing, what was surprising.

After a month, look at the notes. The next thing to build will be obvious. It probably won't be the next thing you would have predicted from the architecture doc.

The architecture is a destination. The MVP is the first step on a path you don't fully know yet. Don't try to make the first step look like the destination. Make it the smallest thing that lets you start walking, and let the path reveal itself.

This is also an honest test of whether the bigger architecture is right. If the MVP works and naturally wants to grow into something resembling what we sketched, that's evidence. If it works but wants to grow somewhere different, the architecture was wrong in interesting ways. If it doesn't work at all, the diagnosis was off and you've saved months building toward a wrong destination.
