# Product

## Register

product

## Users

A small group of trusted, technical operators: the maintainer plus a handful of collaborators fluent in terminals, branches, and the Claude Agent SDK. They open the app to steer autonomous work, not to learn what tasks are. They expect dense information, keyboard fluency, and no training wheels. Onboarding for strangers is not a design constraint; respect for muscle memory is.

The load-bearing moment is the first five seconds after opening any view: instant situational awareness — what is running, what is blocked, what needs attention — without scanning, hunting, or clicking through chrome.

## Product Purpose

Task Orchestrator is the cockpit for planning work and delegating implementation to Claude Agent SDK sessions. It owns the state machine (plans, tasks, criteria, transitions), the agent runs (worktree, branch, PR, cost, event stream), and the human-in-the-loop surface that ties the two together. Success is operator throughput: how many agents one person can supervise in parallel, how fast they spot a stuck one, how confidently they intervene.

This is not Jira, Linear, or a Claude wrapper. It is an opinionated control plane for one workflow: human writes the plan and criteria, agent attempts the implementation, human reviews the PR.

## Brand Personality

**Calm, precise, expert.** The interface reads like instrumentation, not marketing. Confident defaults, restrained color, deliberate typography. No cheerful illustrations, no encouragement, no celebratory toasts. Status is the language; everything else is supporting cast.

Reference points: Linear's status discipline and dense-but-quiet layouts; Raycast and Arc's keyboard-first ergonomics and snappy interaction model. Dark is the default surface because operators work alongside a terminal at irregular hours; light mode is the alternate.

## Anti-references

The app must **not** look like:

- **Generic Jira / Asana / Monday SaaS.** Bright primary blues, cheerful empty-state illustrations, cluttered toolbars, modal-heavy flows, "Welcome back!" banners. Friendly-corporate is the failure mode.
- **AI-startup gradient slop.** Purple-to-pink hero gradients, glassmorphism, glow effects, big-number / small-label hero metrics, "Powered by AI" everywhere.
- **Bootstrap / template admin.** Sidebar + breadcrumb + card-grid-of-stats applied indiscriminately to every page. No opinion, no shape, every screen the same.
- **Notion-soft cozy.** Large rounded corners, gray-on-white pillows, friendly emoji icons. Too soft for an operator tool; reads as a planner, not a control plane.

If a design choice could appear in any of those four families, it is the wrong choice for this product.

## Design Principles

1. **Status carries the page.** The task state machine (todo / in_progress / review / blocked / done / cancelled) and the session lifecycle are the spine of the UI. Glyphs, color, and layout make state legible before anything else. If a view doesn't surface state at first glance, it has the wrong information architecture.

2. **Density that breathes.** Trusted technical users want more per screen than mass-market apps would dare. Earn density through hierarchy (scale, weight, color), not by compressing whitespace into nothing. Same padding everywhere is monotony; rhythm comes from deliberate variation.

3. **Restraint as identity.** The brand is the absence of decoration. Tinted neutrals carry 90% of the surface; the six semantic state colors are the accent vocabulary; no extra palette. Color appears where it conveys meaning, not where it would look nice.

4. **Keyboard before pointer.** The audience reaches for the keyboard first. Shortcuts, jump-to-anything, fluent focus management, command-palette thinking. Mouse-only flows are a smell.

5. **Expose the agent, don't paper over it.** Session logs, event streams, token counts, cost, and PR links are first-class UI, not "advanced" hidden behind a disclosure. The product's edge is that it shows the machine; pretending the agent is a black box would betray the user it's built for.

## Accessibility & Inclusion

Target WCAG 2.1 AA across the app:

- Contrast: body text and status glyphs meet AA in both themes; verify the six state hues in dark mode where saturated colors on near-black are the riskiest combination.
- Keyboard: every interactive surface (task rows, kanban cells, criterion checkboxes, session controls) reachable and operable by keyboard, with focus rings that look intentional rather than browser-default ugly.
- Motion: honor `prefers-reduced-motion`; the existing motion vocabulary is already quiet (fade-in only), keep it that way.
- Forms: every input has an associated label; error messages reference the field, not the form.

No specific user-disability commitments beyond this; if any collaborator surfaces a need, treat it as authoritative and exceed AA where required.
