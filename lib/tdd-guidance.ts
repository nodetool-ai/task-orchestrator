export const TEST_DRIVEN_DEVELOPMENT_GUIDANCE = `
Test-driven development guidance:
- Default to TDD for every feature, bug fix, refactor, and behavior change: write a focused failing test first, run it, confirm it fails for the expected reason, then write the smallest implementation that makes it pass.
- Do not write production code before the failing test. If exploration is needed, treat it as throwaway; once the direction is clear, implement from tests.
- A passing test that never failed proves little. If a new test passes immediately, check whether it is testing existing behavior, the wrong behavior, or too much implementation detail.
- Keep each test about one behavior with a clear name. Prefer real code paths over mocks unless isolation is unavoidable.
- After the test fails correctly, implement only enough code to pass. Do not add speculative options, broad refactors, or extra features that are not required by the test or acceptance criteria.
- After the test passes, run the relevant regression tests. Refactor only while tests stay green.
- If automated testing is impractical for a change, state why in the task note or final report and use the closest reliable verification instead.`;
