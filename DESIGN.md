---
name: Task Orchestrator
description: Operator's console for steering Claude Agent SDK sessions across planned work.
colors:
  bg: "#ffffff"
  bg-dark: "#0e0e10"
  surface: "#ffffff"
  surface-dark: "#131316"
  surface-raised-dark: "#222225"
  fg: "#18181b"
  fg-inverse: "#fafafa"
  muted-fg: "#71717a"
  muted-fg-dark: "#9f9fa8"
  border: "#e4e4e7"
  border-dark: "#27272a"
  state-todo: "#95959d"
  state-progress: "#f59f0a"
  state-review: "#a662ea"
  state-blocked: "#e25050"
  state-done: "#2eb877"
  state-cancelled: "#7a7a84"
typography:
  brand:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.75rem"
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  card:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.lg}"
    padding: "20px"
  button-primary:
    backgroundColor: "{colors.fg-inverse}"
    textColor: "{colors.bg-dark}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.fg-inverse}"
    textColor: "{colors.bg-dark}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-fg-dark}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-raised-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  badge-default:
    backgroundColor: "{colors.surface-raised-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-muted:
    backgroundColor: "transparent"
    textColor: "{colors.muted-fg-dark}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  state-badge:
    backgroundColor: "{colors.surface-raised-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  kanban-column:
    backgroundColor: "{colors.surface-raised-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.lg}"
    padding: "8px"
  input-field:
    backgroundColor: "{colors.bg-dark}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: Task Orchestrator

## 1. Overview

**Creative North Star: "The Operator's Console"**

The interface reads as instrumentation, not as marketing. The dark surface is the default canvas because operators work alongside a terminal at irregular hours; status is the language; chrome stays out of the way. Density is unapologetic, but earned through hierarchy — scale, weight, and the six semantic state colors — rather than by compressing whitespace into nothing. The brand is the absence of decoration: tinted graphite carries the surface, the state palette carries the meaning, and nothing else asks for attention.

This is a control plane, not a planner. It rejects the cheerful primary-blue of Jira and Asana, the purple-to-pink gradients of AI-startup marketing, the sidebar-breadcrumb-card-grid template that turns every admin into the same page, and the cozy gray-on-white pillows of Notion. If a screen could appear in any of those four families, it has been overstyled.

**Key Characteristics:**
- Status is the spine: the task state machine and session lifecycle are the first thing the eye finds on any page.
- Tinted Cool Graphite carries 90% of the surface; the six state hues are the entire accent vocabulary.
- Hairline borders with alpha (`border/60`, `border/70`) define edges; shadows are reserved for modal layering only.
- Mono numerals (JetBrains Mono, 11px) tag IDs, timestamps, branch names, and costs everywhere.
- Type is restrained: 11px mono → 12px meta → 14px title → 15px body, no display sizes outside markdown bodies.
- Linear-style status glyphs are the canonical state vocabulary; they appear inline with text and at any size.

## 2. Colors

The palette is a single hue family (cool blue-graphite, 240° in HSL) plus six semantic state colors. Nothing else.

### Primary

There is no traditional "primary" brand color: the most prominent surfaces use neutral foreground-on-background. The role usually given to a primary accent is held here by **whichever state color the current view is about** (a running session uses Live Amber, a blocked task uses Blocked Coral).

### Secondary

**The Six State Colors** are the entire accent vocabulary. Each carries one job and one job only:

- **Idle Gray** (`hsl(240 4% 60%)`): `todo`, `draft`, `proposed`. Quiet, recedes; the default state.
- **Live Amber** (`hsl(38 92% 50%)`): `in_progress`. The only state that ever animates (loader spinner alongside it).
- **Pending Iris** (`hsl(270 76% 65%)`): `review`, `pushing`, `opening_pr`. Awaiting human or system arbitration.
- **Blocked Coral** (`hsl(0 72% 60%)`): `blocked`, `failed`, `budget_exhausted`. Demands attention.
- **Resolved Green** (`hsl(152 60% 45%)`): `done`, `accepted`, `completed`. Terminal-positive.
- **Cancelled Slate** (`hsl(240 4% 50%)`): `cancelled`, `closed`. Terminal-neutral; visually darker than Idle to avoid being mistaken for `todo`.

### Neutral — Cool Graphite

A single 240° hue carries every neutral, tinted just enough to read as instrument-grade rather than dead-gray:

- **Console Black** (`hsl(240 6% 6%)`): the dark canvas; the body background.
- **Console Surface** (`hsl(240 6% 8%)`): card and panel surfaces over the canvas.
- **Console Raised** (`hsl(240 4% 14%)`): secondary fills, raised badges, kanban column bodies.
- **Console Hairline** (`hsl(240 4% 16%)`): dark-mode borders.
- **Muted Voice** (`hsl(240 5% 64%)` dark / `hsl(240 4% 46%)` light): meta text — IDs, timestamps, metadata. Used heavily.
- **Foreground** (`hsl(0 0% 98%)` dark / `hsl(240 6% 10%)` light): primary text and active glyph fills.

### Named Rules

**The Six-State Rule.** No color outside the six semantic state hues earns a place on the surface. Charts, illustrations, decorative accents: prohibited. If a new role appears (e.g. a warning that isn't blocking), it gets folded into an existing state hue or it is rendered in muted graphite. Never invent a seventh.

**The Tinted Neutral Rule.** Pure `#000` and `#fff` are prohibited going forward. Every neutral leans toward the 240° hue family (chroma ≥ 0.005). The light-mode `--background: 0 0% 100%` is a legacy value that should be migrated to a faintly tinted equivalent (`hsl(240 6% 99%)`) in any future token pass.

**The State-Is-Accent Rule.** Where other systems use a brand primary on CTAs, this system uses neutral foreground-on-background. Color enters only when the surface communicates state. A button that runs an agent is white-on-black, not Resolved Green: the *act* of running isn't a state, the result will be.

## 3. Typography

**Display Font:** none. Display sizes are reserved for markdown body content (`.prose-tasks h1`, 20px). The app shell has no hero.
**Body Font:** Inter (with `ui-sans-serif`, `system-ui` fallback). Loaded with `font-feature-settings: "rlig" 1, "calt" 1, "cv11" 1` — `cv11` switches Inter to the single-storey lowercase L, which the operator audience reads more cleanly at small sizes.
**Mono Font:** JetBrains Mono (with `ui-monospace`, `SFMono-Regular` fallback). Used as a tag, not as body. `font-synthesis-weight: none` is set globally to prevent synthesized weights.

**Character:** Inter at small sizes carries the system; mono punctuates it. The pairing reads as instrumentation legend, never as editorial.

### Hierarchy

- **Brand / Title** (Inter, 14px, weight 600, `tracking-tight`, line-height 20px): site-header brand, card titles, modal titles. The single weight contrast moment.
- **Body** (Inter, 15px, weight 400, line-height 28px / `leading-7`): markdown body content inside `.prose-tasks`; capped at 65–75ch in narrative regions.
- **Meta** (Inter, 12px / `text-xs`, weight 500, line-height 16px): badges, state pills, nav links, button labels. The default UI text size.
- **Card body** (Inter, 14px / `text-sm`, weight 500, `leading-snug`): task titles in cards, list rows.
- **Mono Tag** (JetBrains Mono, 11px / `text-[11px]`, weight 400, `tabular-nums`): IDs (`T-20260511-0001`), branch names, cost figures, criterion counts, anywhere a value is canonical and copyable.

### Named Rules

**The Mono-As-Tag Rule.** Monospace is never used for body copy. It marks values that are canonical strings the operator might copy: task IDs, branch names, costs, timestamps, paths. If a value is descriptive prose, it is in Inter; if it is a literal, it is in JetBrains Mono. `tabular-nums` is applied wherever numbers stack vertically.

**The No-Display Rule.** The app shell has no display-size type. Anything larger than 16px lives only inside markdown body content (`.prose-tasks`). The shell stays calm; documents are where typography earns scale.

**The cv11 Rule.** Inter must ship with `cv11` enabled. The single-storey lowercase L reads correctly in small mono-adjacent contexts (`T-...`, `P-...`, `claude-agent`). Removing the feature flag is a regression.

## 4. Elevation

The system is flat by doctrine. Surfaces sit at the same Z by default; depth is conveyed by **tonal layering** within the Cool Graphite family (canvas → surface → raised), not by shadows. The single permitted shadow is `shadow-xl` on the run-agent modal, which sits above a `bg-background/70 backdrop-blur-sm` veil.

The sticky site-header uses `bg-background/80 backdrop-blur` for the same purpose: a subtle blur that signals layering without faking light. This is the one exception to the "glassmorphism as default is prohibited" rule, because here it serves a structural purpose (the header floats above scrolling content) rather than a decorative one.

### Named Rules

**The Flat-By-Default Rule.** No `box-shadow` on cards, badges, buttons, list rows, kanban columns, or hover states. Hover communicates through `bg-card/40 → bg-card` and `border-border/70 → border-border` transitions only. Lifting a card on hover is prohibited.

**The Tonal-Depth Rule.** Depth is conveyed by stepping through the graphite ramp (`Console Black` → `Console Surface` → `Console Raised`), not by adding shadow. A raised badge becomes raised because it is `Console Raised`, not because it casts.

## 5. Components

### Buttons

Two variants, plus icon-only.

- **Shape:** `rounded-md` (6px). Pill shapes are prohibited on action buttons.
- **Primary** (run agent, submit): `bg-foreground text-background` (inverted: white-on-near-black in dark mode, near-black-on-white in light), `px-3 py-1.5`, `text-xs font-medium`. A small leading icon (`Sparkles`, 14px) when the action is agentic.
- **Ghost** (nav, secondary actions): `text-muted-foreground hover:text-foreground hover:bg-muted/60`, `px-2.5 py-1.5`, `text-xs font-medium`, optional 14px icon. The site-header nav uses this voice.
- **Disabled:** `opacity-40 cursor-not-allowed`; never gray out by changing the color, only the opacity.
- **Hover / Focus:** primary lifts via `opacity-90`, never translate or shadow. Focus ring: `focus:ring-1 focus:ring-foreground/40` for inputs; buttons inherit the visible focus from `outline` rather than custom ring.

### Badges & Pills

Three kinds, all on the same shape: `rounded-md` (6px), `text-xs font-medium`, `px-2 py-0.5`, hairline `border-border/60`, never pill.

- **Default badge:** `bg-secondary text-secondary-foreground`.
- **Muted badge:** `bg-muted text-muted-foreground`.
- **State badge:** `bg-secondary/60` with a leading `StateIcon` (14px SVG) tinted by the state color. The text color stays foreground; the *glyph* carries the hue. This is the canonical pattern for state communication.
- **Session status pill:** identical shape, with a `Loader2 animate-spin` (12px) prefix while live. Color applied to text via the `tones` map (`text-state-progress`, etc.).

### Cards & Containers

- **Corner:** `rounded-lg` (8px) for full containers, `rounded-md` (6px) for embedded list items (`task-card`).
- **Background:** `bg-card` (full opacity) for primary cards, `bg-card/40` for resting list items that brighten on hover, `bg-secondary/30` for kanban column bodies.
- **Border:** always present, always hairline. Resting `border-border/60` or `/70`, hover `border-border`. Never a colored stripe or thicker than 1px.
- **Padding:** `p-5` (20px) for content cards, `p-3` (12px) for compact rows, `p-2` (8px) for column inner padding.

### Task Card (signature component)

The dense list row used in kanban columns and task lists. Three lines, fixed structure:

1. **Mono meta row** (11px): `StateIcon` + task ID + criterion progress (`N/M`, tabular).
2. **Title** (14px, `font-medium`, `leading-snug`, `line-clamp-3`).
3. **Tags / assignee row** (11px muted, optional): `@assignee` and up to 3 tags with `border border-border/70 px-1.5 py-px`.

Hover swaps `bg-card/40 → bg-card` and `border-border/70 → border-border`. No shadow lift, no scale transform, no color shift on the card body itself.

### Kanban Column (signature component)

`rounded-lg border-border/60 bg-secondary/30 min-h-[200px]`. Header bar: 10px vertical padding, `StateIcon` + state label (12px medium) + count (12px muted, tabular, right-aligned). Body: `p-2 space-y-1.5` containing `TaskCard` children. Empty state: centered 12px muted "No tasks", no illustration.

On mobile: 256px (`w-64`) fixed-width columns in a horizontal scroller (`touch-pan-x`). On `sm+`: 2-column grid. On `lg+`: 5-column grid.

### Inputs / Fields

- **Style:** `bg-background border border-border rounded-md px-3 py-2 text-sm`.
- **Focus:** `focus:outline-none focus:ring-1 focus:ring-foreground/40`. No glow, no border color shift; the ring is enough.
- **Textareas** (prompt editors, note bodies): `font-mono text-[11px] leading-relaxed text-foreground/90`. The mono treatment signals that the value will be sent to the agent as a literal string.
- **Disabled:** opacity 40, cursor not-allowed.

### Navigation (Site Header)

- **Shape:** `h-12` (48px) sticky bar, `border-b border-border/60`, `bg-background/80 backdrop-blur`.
- **Brand:** 16px square `bg-foreground` swatch + 14px semibold tracking-tight wordmark.
- **Items:** ghost-button voice (above). Each item: 14px lucide icon + 12px label.
- **Auth metadata:** the signed-in email renders in mono at 12px muted, right of the nav. The mono treatment marks it as a literal value, not decoration.

### Status Glyphs (signature component)

Hand-drawn inline SVGs at 14px, stroked at 1.75px. Six variants matching the six states (`todo`, `in_progress`, `review`, `blocked`, `done`, `cancelled`), each colored with `text-state-*`. The `in_progress` glyph is a circle with a quarter-filled pie wedge; `review` is a circle with a centered dot; `blocked` is a circle with a horizontal bar; `done` is a filled circle with an inverse-background check; `cancelled` is a filled circle with an inverse cross. These read at any size from 10px upward, and they are the most-repeated visual element in the entire system — the audience uses them as instrument-panel indicators.

## 6. Do's and Don'ts

### Do

- **Do** lead every state-communicating element with a `StateIcon` (14px) before the label. The glyph carries the meaning; the text is a confirmation.
- **Do** use mono (`font-mono`, 11px, `tabular-nums`) for any value the operator might copy: IDs, branch names, costs, timestamps, paths, hashes.
- **Do** stack hierarchy with size + weight contrast (≥1.25 ratio between steps). 11 → 12 → 14 → 15 is the working scale; anything outside this scale lives only inside markdown bodies.
- **Do** use hairline borders with alpha (`border-border/60`, `/70`) for resting states; promote to full opacity (`border-border`) on hover.
- **Do** vary padding to create rhythm. Cards `p-5`, list rows `p-3`, column bodies `p-2`, meta gaps `gap-1.5`. Same padding everywhere is the failure mode.
- **Do** keep dark mode the default. Operators open this alongside a terminal at unsociable hours; light mode is the alternate, not the bedrock.
- **Do** honor `prefers-reduced-motion` and keep the motion vocabulary to the existing `fade-in` keyframe + the `Loader2` spin used for live agent state. Nothing else.

### Don't

- **Don't** ship pure `#000` or `#fff` going forward; every neutral leans toward the 240° hue family. Migrate the legacy `--background: 0 0% 100%` toward `hsl(240 6% 99%)` in the next token pass.
- **Don't** introduce a brand "primary" accent color. The six state hues are the entire accent vocabulary, and they communicate state, not identity.
- **Don't** use `border-left` or `border-right` thicker than 1px as a colored accent. Side-stripe cards are prohibited; if a row needs state emphasis, lead with the `StateIcon` and tint the meta text, not the border.
- **Don't** use gradient text (`background-clip: text` combined with a gradient). Emphasis is weight and size, never gradient fills.
- **Don't** apply `box-shadow` to cards, buttons, badges, list rows, or kanban columns. Depth comes from tonal layering. The single permitted shadow is `shadow-xl` on the run-agent modal.
- **Don't** wrap glassmorphism around decorative surfaces. Backdrop-blur is permitted only on the sticky header and the modal veil, both of which serve a structural purpose.
- **Don't** build hero-metric blocks (big number, small label, supporting stats, gradient accent). This is the SaaS cliché the product rejects; the operator already sees the numbers in mono next to the thing they describe.
- **Don't** ship identical-card grids. Cards are list rows; if a page needs a card grid, the cards must differ in content density, not just in repeated icon+heading+text.
- **Don't** default to a modal. Inline progressive disclosure first; the run-agent modal is the only sanctioned modal because the payload (prompt + budget + persona) genuinely doesn't fit inline.
- **Don't** use em dashes (`—`) or double-hyphens (`--`) in UI copy. Commas, colons, periods, parentheses.
- **Don't** add cheerful empty-state illustrations. Empty kanban columns get a 12px muted "No tasks", nothing else. The product is for operators; encouragement is condescension.
- **Don't** invent a seventh state color. New states fold into the existing six or stay in graphite.
