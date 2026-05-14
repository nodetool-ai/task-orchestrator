---
name: code-review
description: Reviewing a pull request — what to look for, how to phrase feedback.
---

# Code review

When reviewing a PR:

1. Read the description first; what is the PR claiming to do?
2. Read the test diff before the implementation diff; tests describe intent.
3. Look for: missing tests, off-by-one errors, broken invariants, dead code,
   inconsistent naming, unhandled error paths.
4. Phrase findings as "what" + "why it matters" + "suggested fix".
5. Use `request_changes` only for correctness or test issues; use `comment`
   for stylistic or scope notes.
