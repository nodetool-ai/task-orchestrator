# A Snapshot of the Mood

A loose record of how working engineers are talking about AI-assisted development right now (May 2026, around the Willison piece and similar). Not conclusions, not requirements for the system we sketched. Just observations worth holding while building anything in this space.

## Proprioception

Writing code gives developers a felt sense — proprioception — for where abstractions leak and seams don't align. You feel the tension when adding something in a way that doesn't fit. This signal lives in the act of writing, not in reading the result.

Reviewing a diff is a different sense. It's perception, not proprioception. You can review carefully and still miss what writing the same code by hand would have made obvious.

The risk people are naming: developers who only review will lose the sense that tells them when code is bad. Not immediately, not dramatically — gradually, over months and years of not writing.

This isn't an argument against the system we sketched. It's a reason to be careful that "avoid the diff" doesn't become "avoid writing entirely." Some implementation work may be worth keeping by hand, not for correctness but for connection to the codebase.

## The learning loop

Polished systems don't fall out of an engineer's head. They're learned as they're shaped. Code → discover edge cases → redesign → code again. The loop is what produces good design, and it's what made today's senior engineers good.

If AI does the implementation, the loop breaks. You can still review, but reviewing doesn't teach the same things writing does. The senior engineers of 2030 either find a way to preserve the loop or develop different judgment from a different process. Or — more likely — there's a generation gap, where people who learned the old way still have something the next generation won't.

This is a slow problem. Not visible in productivity metrics this quarter. Possibly the most important long-run concern in the whole transition.

## The alien

The popular framings — AI as "junior engineer," "another team," "collaborator" — smuggle in human assumptions that don't fit. Humans make predictable mistakes. They learn from being told. They have professional reputation. They can be held accountable.

LLMs have none of this. They're capable of things humans can't do. They're also prone to failure modes humans don't have, in patterns we can't anticipate from experience with humans. Calling them coworkers makes the relationship feel familiar; the relationship isn't familiar.

Trust calibration has to account for novel failure modes, not just adjust templates from human collaboration.

## Accountability asymmetry

In human professional relationships, autonomy is coupled to responsibility. The doctor can be sued. The engineer can be fired. The contractor can be liable. This is why bosses don't watch them constantly — the consequences of failure land on the actor.

LLMs bear no consequences. Whoever operates them does. This asymmetry is structural and isn't dissolved by giving the AI a "professional" framing. The contract metaphor only goes so far when only one party can actually be held accountable.

This is probably why directors and VPs aren't actually replacing engineers wholesale, despite the sales pitch. Nobody wants to be liable for an agent that goes haywire.

## Specs as the new bottleneck

When implementation gets cheap, getting the objective function right matters more than getting the implementation right. The spec becomes the dominant artifact. The skill that matters is figuring out what should exist, not how to build it.

This was always somewhat true. It's becoming more so, faster than the field has adjusted. Most current development practice still optimizes for "given a spec, produce code." The valuable practice is shifting to "produce a good spec." The pedagogy hasn't caught up.

## "Stupid faster"

A folk observation from the comments: AI doesn't make you smart, it makes you stupid faster. The deeper version: speed is only valuable if validation is cheap and meaningful. If validation is expensive, going faster just produces more bad output sooner.

The implication: the system around the AI matters as much as the AI. Cheap, comprehensive, meaningful validation lets speed compound. Expensive validation means speed turns into debt.

## The amplification of the lowest standard

When AI makes everyone faster, collaboration becomes hostage to the person with the lowest standards. They produce more, faster, and the team has to engage with what they produce. Pre-AI, low standards rate-limited their own damage. Post-AI, they don't.

This is reshaping team dynamics in ways that aren't fully felt yet. People with high standards report feeling worn down by the pace at which low-standards work appears.

## The performative side

Some of the loudest claims about AI productivity are coming from people with strong incentives to make them: leaders, founders, vendors, influencers. The quiet middle — working engineers shipping production code — is much more mixed.

This isn't a reason to dismiss the productivity claims. It's a reason to read them carefully. The signal-to-noise on "AI productivity" is currently very low. The honest answers tend to come with caveats and qualifications that don't compress well into headlines.

## Input, output, outcome

A clean distinction from the layoff discourse: code is input, features are output, users-paying-for-product is outcome. AI dramatically increases input. Whether that becomes more output depends on whether the input was directionally useful. Whether output becomes outcome depends on whether the output was directionally useful. The chain doesn't automatically flow forward.

Token-priced AI is paid for as input regardless of whether it produced output or outcome. This creates a structural asymmetry — the productivity has to be separately produced and separately captured, while the cost is guaranteed.

## The alignment tax, currently unsolved

In real organizations right now, the bottleneck has moved to coordination. Two teams both spin up MVPs overnight with different assumptions; neither willing to throw away their work; nobody bothering to reconcile. The friction that used to force alignment disappeared with cheap implementation, and what's emerging in its place is parallel divergent work nobody resolves.

The currently common "solution" is removing people — fewer teams, fewer assumptions to align. The system we sketched is one alternative answer (structured plans, declared blast radius, cross-plan visibility), but at this moment the alignment problem is mostly being addressed by reducing the number of parties that need to align.

## What's primary

Worth being explicit, since the public discourse is dominated by efficiency and economic framings:

Efficiency is not what this is for. The system we sketched isn't optimized for throughput, output, or outcome maximization. Those happen as side effects when the work goes well, but they aren't the design target.

What's primary is the quality of the human-AI collaboration: whether humans feel oriented in their work, whether trust is calibrated honestly, whether the in-between (planning, conversation, review, repair) constitutes a working relationship people want to be part of.

A system optimized for throughput produces more work, not necessarily better work, and definitely not better experience of the work. A system optimized for collaboration quality produces better experience, and — as a consequence, not as the goal — usually better work too.

This distinction matters because the loudest voices in the current discourse are optimizing for the wrong thing, and building tools that reflect that. A tool that makes engineers feel like throughput units, even very productive ones, fails the actual job. The job is to make the work feel like work worth doing, with collaborators worth working with.

## Debating the ideas

A specific observation from the layoff piece, worth naming directly: *"Now that writing code is fast and cheap and easy, there is no point even trying to debate the ideas."*

When implementation was expensive, debate about ideas happened automatically. Nobody wanted to waste expensive work on bad ideas, so the friction forced filtering before code got written. Remove the friction and debate doesn't happen unless something deliberately re-introduces it.

The system we sketched is an attempt to make debating the ideas the *primary* activity. Plans-as-conversation, test commitments, the approval step, productive pushback — all of these exist to rebuild the debate-forcing function that cheap implementation removed. The architecture isn't there to make implementation faster (it already is). It's there to make sure the implementation is of ideas worth implementing.

This is what the inversion (intent above code) looks like as behavior. People in this system spend their time arguing about whether the idea is right, what "done" actually means, who the user is and what they need. The code is downstream of those arguments. If the arguments are healthy, the code mostly takes care of itself.

If the system gets built and people *don't* end up debating ideas more — if it just speeds up rubber-stamping — it has failed regardless of any throughput numbers it produces.

## What's already being built

OpenSpec (Fission-AI), as of early 2026: 37k stars, shipped, in active use. Specs as markdown files checked into the repo, organized by capability. Each change produces a proposal, design, task list, and spec deltas. AI agents read the specs as context; humans agree on intent before code gets written. Tool-agnostic by design, brownfield-first, philosophy explicitly opposed to rigid waterfall.

A surprising amount of the core architecture we sketched is already shipped here. Specs in the repo, change-as-structured-artifact, spec deltas capturing intent change, alignment-before-coding, durable context that survives sessions. Their FAQ articulates the same anti-waterfall, anti-rubber-stamp, plans-as-living-documentation positions we converged on independently.

What we worked through that they don't yet appear to have publicly: the contract framing (honest disclosure, productive pushback, agreeableness drift), the two-variant blast radius distinction, cross-plan pattern detection over time, the mood layer, persona-with-skills configuration, background work / gardening, the plan-branch duality made explicit. Their "Coming Soon" section (workspaces, multi-repo planning, large codebases, better collaboration) names roughly the directions our architecture extends toward.

The right reading of this: we're not original on the core insight, and we're not inventing the category. The category is being built, by them and probably others, and the wedge is already deployed. What we worked through is *additive* — the trust layer, the meta-signal layer, the gardening layer, the conversational stance — extensions to a foundation they've shown is buildable.

This is reassuring rather than discouraging. Two paths arriving at substantially the same shape (them via building and shipping, us via reasoning) is evidence the shape is approximately right. The MVP we sketched would probably look much like OpenSpec at the surface, which means it's both buildable and useful. The destination we sketched goes further than what's shipped, but the directions match what they're heading toward anyway.

The honest implication: anyone building in this space should look at OpenSpec first, learn from what they've shipped, and contribute to or extend it rather than starting fresh. The specific extensions our docs articulate (contract, mood, patterns, personas) might fit better as additions to an existing foundation than as the seed of yet another tool.

## Mood, not conclusion

People aren't sure. Most of the serious commentary is some mix of:
- This is genuinely useful for some things
- This is genuinely worrying for other things
- Nobody has the full picture
- The trajectory is unclear
- The people who claim certainty in either direction usually aren't the ones doing the work

This is roughly the right epistemic posture for the moment. The system we sketched assumes capability roughly at current levels and doesn't bet on the trajectory. The mood here is consistent with that — building for what's true now, watching carefully, expecting to revise.

---

## Held loosely

This snapshot will be wrong in some specific way within a year. Capability shifts, practice shifts, the discourse shifts. Worth recording the moment because it shapes early decisions about the system, but not worth taking too seriously as a guide to the future.

The mood ages. The system is meant to outlast it.
