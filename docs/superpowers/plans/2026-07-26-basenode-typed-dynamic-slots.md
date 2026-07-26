# BaseNode Typed Dynamic Slots Plan

> **Scope note:** This plan targets the **nodetool** project — primarily `nodetool-ai/nodetool-core` (Python runtime) and `nodetool-ai/nodetool` (web UI) — not this repository. It lives here as a planning document. Steps use checkbox (`- [ ]`) syntax for tracking and are ordered so each phase lands independently.

**Goal:** Transform `BaseNode._dynamic_properties` from an untyped `dict[str, Any]` into **typed slots**: every dynamic input carries a declared `TypeMetadata`, the type is editable in the UI, and it is enforced both at graph-validation time and at runtime by the `WorkflowRunner` — exactly the way static properties and dynamic *outputs* already are.

**Why:** Today the two sides of a dynamic node are asymmetric:

- Dynamic **outputs** are already typed: `_dynamic_outputs: dict[str, TypeMetadata]`, surfaced as `OutputSlot`s via `get_dynamic_output_slots()`, so downstream edges can be type-checked.
- Dynamic **inputs** are not: `_dynamic_properties: dict[str, Any]` stores bare values, `find_property()` fabricates `Property(name=name, type=TypeMetadata(type="any"))`, and `assign_property()` skips the `is_assignable()` check that static properties get. Any edge can target any dynamic slot; type errors surface only as confusing failures inside `process()`.

The fix is to give dynamic inputs the same shape dynamic outputs already have, then make the validator, runner, and UI consume it.

**Architecture in one paragraph:** Add a per-instance slot-type map `_dynamic_slots: dict[str, TypeMetadata]` alongside the existing value map `_dynamic_properties`. A slot with no declared type defaults to `any`, which preserves today's behavior and is the migration escape hatch. `find_property()` returns the declared type; `assign_property()` and edge validation enforce it with the existing `is_assignable()` machinery; the graph wire format and API schema carry the map; the UI gets a slot editor (name + type picker) and uses the declared types for handle coloring, connection validation, and widget selection. No new type system is invented — `TypeMetadata`, `Property`, `OutputSlot`, and `is_assignable` are all reused.

---

## Global Constraints

- **Backward compatibility is non-negotiable.** Every existing workflow JSON (no slot types) must load and run unchanged: missing slot type ⇒ `any` ⇒ every check passes vacuously. The change is purely additive on the wire.
- **Reuse the existing type machinery.** Slot types are `TypeMetadata`; input slots surface as `Property`; checks go through `is_assignable`. No parallel "slot type" concept.
- **Symmetry with dynamic outputs.** Naming, storage, serialization, and UI treatment of typed input slots mirror `_dynamic_outputs` / `dynamic_outputs` wherever possible.
- **`any` stays a first-class citizen.** Users who want untyped scratch slots keep them; typing is opt-in per slot.
- **Fail at the earliest layer possible:** UI connection-time > workflow-save validation > run-start graph validation > runtime assignment. Each later layer is a backstop, not the primary UX.
- TDD throughout: failing test first, all suites green before each commit.

---

## Phase 1 — Core model: typed slots in `nodetool-core`

### Task 1.1: Slot storage and metadata on `BaseNode`

**Files (nodetool-core):** `src/nodetool/workflows/base_node.py`, tests alongside existing `base_node` tests.

- [ ] Add `_dynamic_slots: dict[str, TypeMetadata]` (private attr, default `{}`) next to `_dynamic_properties`.
- [ ] Add accessors mirroring the output side: `get_dynamic_slot_types()`, `add_dynamic_slot(name, type_metadata)`, `remove_dynamic_slot(name)` (removal also drops the value from `_dynamic_properties`).
- [ ] `find_property(name)`: for a dynamic name, return `Property(name=name, type=self._dynamic_slots.get(name, TypeMetadata(type="any")))` instead of hard-coded `any`.
- [ ] `properties_for_instance()` / whatever feeds node introspection: include dynamic slots as `Property` entries so tools, agents, and the API see them with real types.
- [ ] Unit tests: declared slot type is reported by `find_property`; undeclared slot still reports `any`; removing a slot removes its value.

### Task 1.2: Enforcement in `assign_property` / `from_dict`

**Files (nodetool-core):** `src/nodetool/workflows/base_node.py`.

- [ ] `assign_property(name, value)`: when the node is dynamic and `name` has a declared slot type, run the same `is_assignable(type, value)` check (and the same conversion/coercion path) static properties get; raise the same error type with a message naming the node, slot, declared type, and received type. Undeclared / `any` slots keep today's accept-anything path.
- [ ] `from_dict(...)`: parse the new `dynamic_slots` field (see Task 1.3), populate `_dynamic_slots` before values are assigned, and validate initial `dynamic_properties` values against it.
- [ ] Unit tests: assigning a mismatched value to a typed slot raises; matching value passes; `any` slot passes anything; conversion rules (e.g. int→float) behave identically to static properties.

### Task 1.3: Wire format and API schema

**Files (nodetool-core):** `src/nodetool/types/graph.py` (Node model), serialization in `base_node.py` (`to_dict` / graph export), API schema regeneration.

- [ ] Add `dynamic_slots: dict[str, TypeMetadata] = {}` to the graph `Node` model, next to the existing `dynamic_properties` and `dynamic_outputs` fields. Values stay in `dynamic_properties` — the two maps are keyed identically.
- [ ] Round-trip serialization: `to_dict` emits `dynamic_slots`; `from_dict` reads it; absent field ⇒ empty map ⇒ all-`any` (backcompat).
- [ ] `NodeMetadata` / `metadata()` output: no change needed for class metadata (`is_dynamic` already flags capability), but instance serialization for the editor must include the slot map.
- [ ] Regenerate the OpenAPI schema / frontend client types so the UI sees the new field.
- [ ] Tests: old-format JSON (no `dynamic_slots`) loads and runs; new-format round-trips losslessly.

---

## Phase 2 — Validation and runtime enforcement

### Task 2.1: Graph edge validation

**Files (nodetool-core):** graph validation (`Graph.validate_edges` or equivalent in `src/nodetool/workflows/graph.py`).

- [ ] When an edge targets a dynamic node handle: resolve the target type via `find_property()` (now type-aware from Task 1.1) instead of skipping the check, and validate source-output type against it with `is_assignable`.
- [ ] Error messages name node title/id, slot name, and both types — these strings surface in the editor, so make them human-readable.
- [ ] Tests: valid edge into typed slot passes; invalid edge fails with the expected message; edge into `any` slot always passes; dynamic-output → typed-dynamic-input edge is checked end to end.

### Task 2.2: `WorkflowRunner` runtime enforcement

**Files (nodetool-core):** `src/nodetool/workflows/workflow_runner.py` (and actor/inbox delivery path if messages bypass `assign_property`).

- [ ] Run-start: graph validation from Task 2.1 executes before any node runs, so a stale saved workflow with a now-invalid edge fails fast with a `NodeError`-style report rather than mid-run.
- [ ] Message delivery: every path that writes an inbound value into a dynamic slot goes through `assign_property` (Task 1.2) so streamed/per-message values are checked and converted identically to static inputs. Audit for any direct `_dynamic_properties[...] = value` writes and route them through the checked path.
- [ ] Tests: e2e workflow with a typed dynamic node (e.g. `MakeDictionary` with `int`-typed slots) rejects a `str` upstream at run start; streaming into a typed slot with a wrong-typed item fails with a clear node-scoped error, not a stack trace from `process()`.

### Task 2.3: Migrate built-in dynamic nodes to declare types

**Files (nodetool-core / nodetool node packages):** dynamic node implementations (`FormatText`, `MakeDictionary`, template/agent-tool nodes, etc.).

- [ ] Nodes that *derive* their slots (e.g. `FormatText` creating a slot per `{{ var }}` in the template) declare them typed (`str` for format vars) via `add_dynamic_slot` instead of relying on untyped fallback.
- [ ] Nodes that are genuinely open (`MakeDictionary`) keep `any` as the default for user-created slots but respect user-declared types.
- [ ] Sweep: grep node packages for `_dynamic_properties` access and confirm each either declares types or is intentionally `any`.

---

## Phase 3 — UI: slot editing and type-aware canvas (`nodetool-ai/nodetool` web)

### Task 3.1: Slot editor

- [ ] In the node inspector for `is_dynamic` nodes, replace the bare "add property" name+value affordance with a slot editor: **name, type, value/default**. Type picker reuses the existing `TypeMetadata` selector used elsewhere (asset types, primitives, unions, list/dict parameterization); default remains `any`.
- [ ] Rename and delete keep values and connected edges consistent (renaming a slot re-targets its edge handle or disconnects with a warning; changing a type that invalidates an existing edge warns and, on confirm, removes the edge).
- [ ] Persist to `node.data.dynamic_slots` alongside `dynamic_properties`; both flow through existing save/load.

### Task 3.2: Type-aware canvas behavior

- [ ] Handles for typed dynamic slots use the same per-type coloring/tooltip as static handles (existing type→color util).
- [ ] Connection validation (`isValidConnection` / connect handlers) consults instance `dynamic_slots` in addition to class metadata, so an illegal edge can't be drawn — mirroring current static-property behavior.
- [ ] **Type inference on connect:** dragging an edge onto a dynamic node's "add slot" handle creates a slot pre-typed from the source output's `TypeMetadata` (user can loosen to `any` afterwards). This makes typing the default without extra clicks.
- [ ] Value widgets: the property panel picks the editor widget by slot `TypeMetadata` (number field, text area, enum select, asset picker…) via the existing property-widget dispatch, instead of a generic any/string editor.

### Task 3.3: Surfacing validation errors

- [ ] Save-time and run-start validation errors from Phase 2 render on the offending node/edge (existing node-error UI), with the slot name and both types visible.

---

## Phase 4 — Migration, docs, rollout

- [ ] **Data migration: none required.** Absent `dynamic_slots` means all-`any`; stored workflows are untouched. Optionally, a best-effort backfill script can infer slot types from stored literal values (`5` ⇒ `int`) — run it only as an opt-in CLI, never automatically.
- [ ] Version notes in nodetool-core changelog; document the slot API for node authors (how to declare typed dynamic slots, when to leave `any`).
- [ ] Rollout order: Phase 1+2 (core) ship first behind full backcompat — with no UI they are invisible except to node authors; Phase 3 ships once the regenerated client types are published. No feature flag needed because untyped slots behave exactly as before.

## Risks

- **Hidden write paths:** anything mutating `_dynamic_properties` directly (serializers, agent tooling, providers) bypasses enforcement — the Task 2.2 audit is the mitigation.
- **Coercion drift:** dynamic-slot conversion must share code with static-property conversion, not re-implement it, or the two will diverge (e.g. dataframe/asset coercions).
- **UI edge cases:** renames and type changes on slots with live edges are the fiddly part; the warn-and-disconnect rule keeps the graph consistent at the cost of an occasional re-connect.
- **`any` overuse:** if the UI defaults new manual slots to `any` and never nudges, nothing improves in practice; connect-time type inference (Task 3.2) is what makes typed the path of least resistance.
