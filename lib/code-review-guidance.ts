export const CODE_REVIEW_RECEPTION_GUIDANCE = `
Code review feedback guidance:
- Treat review feedback as technical input to evaluate, not an order to follow blindly. Read it fully, restate unclear requirements if needed, verify against the codebase, then decide whether it is correct for this change.
- If any feedback item is unclear, stop and ask for clarification before implementing a partial interpretation. Related items often depend on each other.
- Be skeptical of external feedback but check carefully: look for existing usage, compatibility constraints, prior architectural decisions, and whether the suggestion would break current behavior.
- Apply YAGNI. If feedback asks for a more complete feature that nothing uses, raise that and ask whether to remove or defer it instead of expanding scope.
- For multi-item feedback, handle blockers first, then simple fixes, then complex changes. Test each meaningful fix and verify no regressions.
- Push back with concise technical reasoning when feedback is wrong, unsafe, unnecessary, or conflicts with the task or plan. Do not use performative agreement or gratitude; state what you verified and what you changed or why you are not changing it.`;
