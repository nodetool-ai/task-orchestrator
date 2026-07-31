# Discord Persona Bots — PRD

**Date:** 2026-07-31
**Status:** Draft
**Companion docs:**
`2026-07-31-discord-personas-messaging-design.md` (technical design),
`../plans/2026-07-31-discord-personas-messaging.md` (implementation plan)

This PRD defines the product and UX. The design doc defines how it's
built. Where they conflict, this document wins on *what the user sees*.

## 1. Product vision

You get work done by texting a colleague. Not by opening a dashboard,
not by learning a CLI — by sending a Discord message to a persona who
knows you, remembers everything, and runs the machinery (plans, tasks,
agent runs, PRs, CI) so you never have to see it unless you ask.

The dashboard becomes the *inspection* surface. Messaging becomes the
*primary* surface.

**One-line pitch:** hire a team of AI colleagues that live in your
Discord.

## 2. Users and jobs to be done

| User | Job | Today's friction |
|---|---|---|
| Solo builder (primary) | "Ship this feature while I'm at lunch" | Open web UI → create plan → create task → write criteria → run agent → poll |
| Team lead | "What's in flight? What's stuck?" | Scan runs table, click into each |
| Occasional contributor | "File this idea before I forget" | Full login + form for a two-line thought |
| Mobile-only moments | Everything above, from a phone | Web UI is desktop-shaped |

Messaging wins precisely where the web UI loses: capture speed, mobile,
ambient awareness, and zero-training interaction.

## 3. Experience principles

These are the product's laws. Every milestone gets reviewed against
them.

1. **Natural language first, commands last.** Anything a slash command
   does must also work as plain English ("start over" = `/new`).
   Commands exist for discoverability and muscle memory, not as the
   API. Target: a new user completes their first shipped PR without
   typing a single `/command` other than `/link`.
2. **One question at a time.** When a persona needs input, it asks
   exactly one question, with a suggested default ("I'll target `main`
   unless you say otherwise"). Never a form, never a numbered
   questionnaire. If the user doesn't answer, proceed with the default
   and say so.
3. **Sensible defaults, loud assumptions.** Personas act without
   permission for reversible things and state assumptions inline
   ("Assuming this belongs to the *Dark Mode* plan"). Irreversible or
   expensive things (merging, force-push, >N parallel runs) get one
   explicit confirmation.
4. **Short messages, progressive disclosure.** Default replies fit on
   a phone screen (≤ ~600 chars). Detail lives one question away
   ("want the full breakdown?") or behind a link to the web UI. Never
   paste a wall of transcript into chat.
5. **Ambient progress, zero polling.** The user should never need to
   ask "how's it going?" — but when they do, the answer is instant and
   current. Progress arrives as thread breadcrumbs; milestones
   (PR opened, CI green, blocked) arrive as persona messages.
6. **Memory is felt, not managed.** Users don't run memory commands.
   They say "I prefer squash merges" once, and it holds forever, across
   threads and across the persona's delegated runs. The persona
   confirms what it learned in one short line ("Noted — squash merges
   from now on.") so memory is trustworthy, not spooky.
7. **Threads are workspaces.** One piece of work = one thread. The
   channel stays scannable: thread titles are status headlines the
   persona keeps updated.
8. **Personas are colleagues, not modes.** Each has a name, an avatar,
   a specialty, and a consistent voice. You pick who to talk to the way
   you'd pick which coworker to ping — and the concierge routes you if
   you pick wrong ("that's more Rex's thing — want me to loop them in
   later / handle it anyway?").

## 4. The roster

Shipped personas (each its own Discord bot; teams can add more):

| Persona | Handle (example) | Specialty | Default when… |
|---|---|---|---|
| **Concierge** (default) | `@Aria` | Front door. Intake, status, routing, end-to-end "just ship it" orchestration | …you don't know who to ask |
| **Planner** | `@Pia` | Turning fuzzy ideas into plans with tasks + acceptance criteria | …scoping something big |
| **Implementor liaison** | `@Ivo` | Driving implement runs, unblocking, re-runs, CI babysitting | …a task is ready to build |
| **QA / Reviewer** | `@Rex` | PR review summaries, "is this safe to merge?", quality nags | …something is in review |

v1 rule of thumb: **Concierge can do everything the others can.** The
specialists exist for focus and voice, not exclusive capability. A solo
user can install only Aria and lose nothing but flavor.

Persona voice guide (enforced via system prompts):
- Competent-casual. No corporate filler, no exclamation-mark
  enthusiasm, no apologizing.
- Status first, detail second, question (if any) last.
- Emojis as status glyphs only (⏳ ✅ ❌ 🔍 🚧), never decoration.

## 5. Core journeys

### J1 — Onboarding (target: < 2 minutes, once)

1. Admin invites the persona bot(s) to the server (docs provide a
   one-click invite URL per bot with the right permission set).
2. User DMs Aria anything ("hi"). Aria replies with a 3-line intro:
   what she can do, one example ask, and — if the user is on the
   allowlist but unlinked — "Want your work attributed to your
   account? Grab a token at `<url>/tokens` and paste it here."
3. User pastes the token (DM only). Aria confirms: "Linked to
   *matti@…*. Everything we do together is now yours in the web UI."
4. First-run nudge: "Try me: *ship a small fix* or *what's in
   flight?*"

No linking is required to talk. Linking is a one-time paste, sold by
its benefit, never a gate.

### J2 — "Just ship it" (the flagship journey)

> **User** (in `#dev`): `@Aria` add a dark-mode toggle to settings
>
> **Aria** creates a thread **🚧 Dark-mode toggle** and replies inside:
> "On it. I'll file this under a new task on the *UI polish* plan,
> have an implementor build it on a branch, and ping you when a PR is
> up. Anything I should know — design constraints, target branch?"
>
> *(user says nothing — default applies)*
>
> Thread breadcrumbs over the next while:
> `⏳ Implementor run #214 started (task T-20260731-0012)`
> `🔍 Run #214: 6/8 acceptance criteria done`
> `✅ PR opened: github.com/…/pull/152`
>
> **Aria**: "PR's up and CI is green — 8/8 criteria met. Summary: adds
> `ThemeToggle` to settings, persists via `useTheme`. Review link
> above. Want Rex to give it a review pass?"

Notes on the mechanics this demands:
- Aria **narrates the plan before executing** (one message), giving a
  natural veto point without asking permission.
- Breadcrumbs are compact, threaded, and never @-mention. Milestone
  messages (PR up, blocked, failed) @-mention the thread owner.
- Thread title is live status: 🚧 → 🔍 (in review) → ✅ (merged) /
  ❌ (cancelled). Renames are done by the persona.
- If the run fails, Aria's message is a *decision*, not a log dump:
  "Run failed on a type error in `theme.ts` (details in thread ↑).
  I'll retry with the fix unless you object." (principle 3).

### J3 — Status ("what's in flight?")

DM or mention, answered instantly from live state, formatted as a
scannable digest, phone-width:

> **You asked → in flight (3):**
> 🚧 Dark-mode toggle — implementor running, ~6/8 criteria
> 🔍 PR #149 payment retries — awaiting your review *(2 days)*
> ❌ Import cleanup — blocked: needs your call on API shape ← reply here
>
> 12 tasks todo across 2 plans. "details" for the full picture.

Rules: max ~5 lines before summarizing; oldest-blocked-on-user items
surface first (the queue is *their* queue); every line has exactly one
next action.

### J4 — Capture ("file this before I forget")

> **User** (DM, from phone): the CSV export mangles umlauts
>
> **Aria**: "Filed: **T-20260731-0019 — CSV export mangles umlauts**
> under *Data quality*. I added a repro criterion. Want it built now or
> just parked?"

Target: idea → filed task in one message round-trip, < 30 seconds.
This journey is why messaging exists; it must never require follow-up
questions for a parkable item.

### J5 — Teach a preference

> **User**: stop targeting `main`, we branch off `develop` now
>
> **Aria**: "Noted — new work branches from `develop`. This applies to
> future runs; #152 is already off `main`, leave it?"

Memory writes are confirmed in ≤ 1 line, applied to persona + user
scope (per design doc), and honored by spawned runs. "What do you
know about me / this repo?" produces a readable list; "forget X"
works conversationally.

### J6 — Review & merge (with confirmation gate)

> **User** (in PR thread): looks good, merge it
>
> **Aria**: "Merging PR #152 (squash, per your preference) — task
> T-…-0012 will close. Confirm?" → user: 👍 (reaction or "yes")
> → "✅ Merged. Thread archived."

Merge/close/cancel are the confirm-gated verbs. A 👍 reaction on the
persona's confirmation message counts as confirmation — reactions are
first-class input for yes/no.

## 6. Interaction model

**Where personas listen** (unchanged from design doc, restated as UX):
- **DMs:** always respond. The private workspace.
- **Channels:** respond only when @-mentioned. First reply always
  opens a thread (keeps channels clean).
- **Their own threads:** every message is for them — no re-mention
  needed. The thread is a continuous conversation with full context.

**Reactions as input:** 👍/👎 on a persona question = yes/no. ❌ on a
breadcrumb = "stop this run" (persona asks to confirm). The persona
reacts 👀 to acknowledge receipt when a full reply will take > ~5s.

**Typing indicator** while a turn is running; throttled draft edits
(existing pipe behavior) so long answers grow in place instead of
flooding.

**Interrupting:** a new user message during a running turn is queued
(existing serialization) — but "stop"/"cancel"/❌ is recognized
pre-queue and aborts the in-flight turn.

**Cross-persona handoff (v1-lite):** personas don't talk to each
other. Handoff = the persona tells you who to ask, or handles it
itself (roster rule). True multi-persona threads are future work.

## 7. Command surface (small, discoverable, optional)

Registered as slash commands on every bot; all have NL equivalents.

| Command | Does | NL equivalent |
|---|---|---|
| `/status` | J3 digest | "what's in flight?" |
| `/new` | Fresh conversation in this thread/DM | "start over" |
| `/stop` | Abort current turn / offer to cancel child runs | "stop" |
| `/link <token>` | Link Discord ↔ account (DM only) | — (the one true command) |
| `/whoami` | Persona name + linked account + active thread's task/run | "who are you / what is this thread?" |
| `/help` | 5-line cheat sheet, persona-specific | "what can you do?" |

Deliberately absent: `/plan`, `/task`, `/run`, `/model`, `/memory` —
these are conversations, not commands. (`/model` remains as a hidden
power-user command from the existing pipe, undocumented in `/help`.)

## 8. Message design system

- **Hard cap ~1800 chars/message** (Discord limit − headroom, existing
  chunker); *soft* cap ~600 chars for default replies (principle 4).
- **Breadcrumbs:** one line, glyph-prefixed, no mention, posted by the
  relay: `⏳ started · 🔍 progress · ✅ done/PR · ❌ failed · 🚧 blocked`.
  Collapse rule: never more than 1 progress breadcrumb per run per
  10 minutes; later breadcrumbs edit the previous one where possible.
- **Milestones:** persona-voiced messages, @-mention the thread owner,
  always end with the next action or an explicit "nothing needed from
  you."
- **Links, not dumps:** transcripts, diffs, long logs → web UI deep
  link (`<base>/runs/214`), presented as "details: <link>". Deep links
  are the escape hatch to full fidelity, and every entity mentioned by
  id (task, plan, run, PR) is linked.
- **Code:** inline backticks for identifiers; fenced blocks only when
  the user asks to *see* code, capped at ~30 lines then linked.
- **Digests over feeds:** if > 3 breadcrumbs would fire within a
  minute (parallel runs), the relay batches them into one message.

## 9. Notifications & attention

- @-mentions are reserved for: blocked-on-you, finished-for-you,
  failed-needs-decision, and explicit confirmations. Everything else
  is mention-free (Discord's unread state is enough).
- **Quiet hours (v1.1):** "don't ping me nights/weekends" stored as a
  user-scope memory; milestones queue and deliver as a morning digest.
  v1 ships without scheduling but personas already honor "stop pinging
  me about X" via memory.
- A persona never sends more than one unprompted DM per event; there
  is no re-ping/nag loop in v1.

## 10. Failure & edge states

| State | UX |
|---|---|
| User not on allowlist | Bot stays silent in guilds; in DM replies once: "I'm not enabled for you — ask <admin> to add you." Never repeats. |
| Unknown/ambiguous ask | One clarifying question with a default (principle 2), never "I can't do that." |
| Child run fails | Milestone message: cause in one line, proposed next step, link to full log. Auto-retry only if the persona states it first. |
| Persona turn errors (backend down) | Honest one-liner: "I hit an internal error and lost that turn — say it again?" Never silent. |
| Long thread / context cap | "This thread's getting long — I'll keep the summary and start fresh here" → `/new` with carried-over summary (memory holds the durable facts). |
| Two personas mentioned in one message | Each answers only if directly mentioned; no dogpiling — the auto-thread belongs to the first mentioned. |
| Discord outage / pipe restart | Conversations resume transparently (state is in Postgres); the persona doesn't announce restarts. |

## 11. Success metrics

Instrument from day one (per-persona, per-user):

- **TTFPR:** time from first message in a thread → PR opened. Target
  median < 30 min for small tasks.
- **Zero-command sessions:** % of threads completing a journey with no
  slash commands. Target > 80%.
- **Clarify rate:** persona questions per user request. Target < 0.5 —
  falling over time as memory accumulates (the memory system's KPI).
- **Digest reply latency:** `/status`-class answers < 5 s.
- **Channel share:** % of plans/tasks/runs created via messaging vs
  web UI — the adoption headline.
- **Unprompted-message tolerance:** mute/leave/allowlist-removal
  events as the "we're being annoying" alarm.

## 12. Out of scope (v1)

- Slack/Telegram (adapter interface stays ready).
- Voice, images-out, rich embeds/buttons (reactions + text only;
  Discord components are a v1.1 candidate for confirmations).
- Persona↔persona conversation; shared multi-persona threads.
- Scheduled/proactive check-ins beyond run-driven milestones.
- Per-guild multi-tenancy.
- In-chat code review line comments (link to GitHub instead).

## 13. Open product questions

1. Do specialists ship in v1 at all, or is v1 Aria-only with the
   roster as fast-follow? (Leaning: Aria + Rex, since review is the
   second-loudest ask.)
2. Is a 👍-reaction a strong enough confirmation for merge, or does
   merge require typed confirmation? (Leaning: reaction suffices —
   it's authenticated and logged.)
3. Should unlinked users be allowed to *create* work, or only to read
   status? (Leaning: allow create — allowlist is the real gate;
   attribution is a bonus.)
4. Thread-title emoji state machine: exact set and who owns renames
   when a human edits the title manually.
