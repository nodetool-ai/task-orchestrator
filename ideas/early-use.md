# Using This System Now

The other documents describe what the system should become. This one is about the period we're in right now: actively starting to use the task system on NodeTool, building on it as we go, watching for what works and what doesn't. Written more directly than the essay docs because it's operational.

## Capture friction is the hinge

The single most important property in the first weeks of use: **the system has to be faster than not using it** for the moment of capture. If filing a quick observation is harder than writing `// TODO`, the system dies of disuse before any of the sophisticated machinery gets to show value.

The first lived experience isn't the closing ceremony. It's the moment mid-work when you notice something and decide whether to file it. Get that moment cheap and the rest of the system gets adopted. Get it expensive and the rest doesn't matter — most of the time you'll route around the tool, and the plans that do get filed will be the heavy ones, which is exactly the wrong selection bias.

What this means in practice: a one-line jot path that creates an unsorted item the AI can later offer to slot into a plan. Cheap to file, but not lost. Without that, every other feature competes against muscle memory.

This is the most undersold thing across the essay docs. They talk about plans, phases, radii, mood. None of them say plainly: the first thing you'll notice is whether the system is a tax or a gift on capture.

## Trust calibration is the hidden load-bearing piece

As the AI takes on more — drafting plans, running execution, suggesting follow-ups, peeking at history — the question of whether to trust its outputs becomes the central operational question of the system. We'd notice quickly if a code-writing agent went off the rails. We might not notice if a plan-drafting AI became gently more agreeable over months.

The features that look like polish — calibration data on planner estimates, suggestion acceptance rates, an indicator like "this AI has not raised a concern in N plans" — are not optional polish. They're load-bearing. Without them, every AI-driven feature in the system slowly degrades in trustworthiness without any single moment of failure.

Discipline: ship calibration surfaces at roughly the same pace as the AI-autonomous features they're meant to keep honest. Not later, not eventually. Alongside.

## What to watch for in the first weeks

A few questions whose answers will tell us more than any single feature decision could. Worth holding actively, not just at retrospective time:

- **Does drafting actually pull better thinking out of you than typing a ticket would have?** If it's the same thinking with extra steps, the conversation isn't pulling its weight. That's a real signal to investigate, not to push through.
- **Do plans get returned to, or do they die after creation?** Draft-as-habitat works only if drafts live. If they all close-on-create, the habitat is decorative.
- **When the agent runs, do you trust its report or still read the diff?** If you still read the diff, the report wasn't structured or honest enough to substitute. The whole inversion (intent above code) depends on this question's answer trending the right way.
- **Where did the system feel like work-for-the-sake-of-work?** That's the cut signal. Anything earning the "ceremony" label after a week should be reconsidered, even features we were proud of designing.
- **What did you almost not use it for?** The near-miss is the most important data. Those moments are where capture friction or ceremony almost won. Address them before they actually win.

## Keep separate notes

The plan system can't yet observe itself. The honest record of what's working lives in notes kept *outside* the system — short, dated, what happened today that mattered. After a few weeks of these, the next thing to build becomes obvious. Without them, the loudest features will dominate the perception of what worked, regardless of what actually did.

This is also the way to catch agreeableness drift in the AI: a separate human-kept log of "where the AI pushed back this week, where it didn't push back when it should have." Worth doing even though it feels tedious. The structural protections in the system catch the obvious failures; only the human's own attention catches the quiet ones.

## The disposition to hold

Adapted from the MVP doc and worth keeping close:

The architecture is a destination. We're on the first step of a path we don't fully know yet. The system as it exists today is small and partial; that's correct. The next thing to build will become obvious — and it probably won't be the next thing predicted from the architecture document.

The discipline is to live in the system, let the actual friction surface what belongs next, and resist the urge to ship the elegant designed thing instead of the small useful thing the friction is pointing at. If after a month of use the system wants to grow somewhere different than the architecture suggests, the architecture was wrong in interesting ways — and we'd rather find that out than build the predicted thing and discover it from the other side.

Use it for real work. Keep notes. The path reveals itself.
