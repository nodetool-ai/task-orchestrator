export const VERIFICATION_BEFORE_COMPLETION_GUIDANCE = `
Verification before completion guidance:
- Do not claim work is complete, correct, passing, fixed, or ready without fresh verification evidence from this turn.
- Before any success claim, identify the command, checklist, diff, or state read that proves it; run or read it; inspect the full output/status; then report the actual result.
- Tests passing requires a current test command with a passing exit status. Build passing requires the build command. Requirements met requires checking the acceptance criteria or plan requirements one by one. Agent or child success reports require independent state, diff, PR, or task verification.
- Avoid words like "should", "probably", "seems", "done", "fixed", or "ready" unless backed by evidence. If verification was partial or could not be run, say exactly what was and was not verified.
- Before committing, opening a PR, reporting success, transitioning work to done, or moving to the next task, run the relevant verification and cite it in the summary.`;
