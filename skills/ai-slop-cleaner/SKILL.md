---
name: ai-slop-cleaner
description: Clean AI-generated code slop with a test-first, deletion-first deslop workflow and optional reviewer-only mode
---

<Purpose>
Use this skill to systematically clean AI-generated code slop without changing intended behavior. It focuses on simplifying existing code by deleting dead code, collapsing duplicates, removing needless abstractions, tightening boundaries, and reinforcing tests before and after cleanup.
</Purpose>

<Use_When>
- The user explicitly says "deslop", "anti-slop", or "AI slop"
- The request is to clean up or refactor code that feels bloated, repetitive, or overly abstract
- The user wants a reviewer-only anti-slop pass via `--review` after cleanup work is drafted
- The user calls out duplicate code, dead code, wrapper layers, boundary violations, or weak regression coverage
- The goal is simplification, deletion, and cleanup rather than adding new features
</Use_When>

<Do_Not_Use_When>
- The task is primarily a new feature build -- use `autopilot` or direct implementation instead
- The user wants a broad architecture redesign rather than an incremental cleanup pass
- The request is a generic refactor with no cleanup/simplification intent
- Behavior is unclear and there are no tests or concrete anchors -- clarify scope first
</Do_Not_Use_When>

<Why_This_Exists>
AI-generated code often works while still adding avoidable complexity: duplicate helpers, dead branches, wrapper layers, inconsistent naming, boundary leaks, and missing tests. This skill enforces a disciplined cleanup workflow so simplification happens deliberately instead of as vague "refactoring" that might expand scope.
</Why_This_Exists>

<Review_Mode>
### Review Mode (`--review`)
`--review` activates an explicit reviewer pass after the cleanup writer pass.

- **Writer pass**: make the cleanup changes with behavior locked by tests.
- **Reviewer pass (`--review`)**: inspect the result for duplication, dead code, boundary violations, missing tests, and unnecessary abstractions.
- The same pass must not both write and self-approve without a separate review step.

In review mode:
1. Do **not** make edits first.
2. Inspect the cleanup plan, changed files, and regression coverage.
3. Check specifically for:
   - leftover dead code or unused exports
   - duplicate logic that was not consolidated
   - needless wrappers or abstractions that still blur boundaries
   - missing tests or weak verification for preserved behavior
   - risky cleanup that changed behavior without explicit intent
4. Produce a reviewer verdict with required follow-ups.
5. If changes are needed, hand them back to a separate writer/executor pass instead of fixing and approving in one pass.

This mode exists to preserve writer/reviewer separation: the authoring pass changes code, the reviewer pass evaluates whether the cleanup actually reduced slop safely.
</Review_Mode>

<Execution_Policy>
- Preserve behavior unless the user explicitly asks for behavior changes
- Lock behavior with regression tests first whenever practical
- Write a cleanup plan before editing code
- Prefer deletion over addition
- Reuse existing utilities and patterns before introducing anything new
- Avoid new dependencies unless the user explicitly requests them
- Keep diffs small, reversible, and smell-focused
- Keep writer/reviewer separation: author in one pass, review in another
- Verify with lint/typecheck/tests/static analysis relevant to the touched area
</Execution_Policy>

<Steps>
1. **Lock behavior first**
   - Identify the current behavior and add or strengthen regression tests before cleanup when practical
   - If tests cannot be added first, record the verification plan explicitly before editing

2. **Create a cleanup plan**
   - Do not start coding immediately
   - List the targeted smells and the files likely involved
   - Sequence cleanup passes from lowest-risk deletion to higher-risk consolidation

3. **Categorize the slop**
   - Duplicate code
   - Dead or unused code
   - Needless abstraction / wrapper layers
   - Boundary violations / misplaced responsibilities
   - Missing or weak tests

4. **Execute one smell-focused pass at a time**
   - **Pass 1: Dead code deletion** -- remove unused branches, helpers, exports, and stale comments
   - **Pass 2: Duplicate removal** -- consolidate repeated logic into existing patterns where possible
   - **Pass 3: Naming and error-handling cleanup** -- tighten naming, trim noisy plumbing, normalize obvious inconsistencies
   - **Pass 4: Test reinforcement** -- fill any regression gaps revealed by the cleanup

5. **Run quality gates**
   - Run the relevant lint, typecheck, unit/integration tests, and any static or security checks already present for the touched area
   - If a gate fails, fix the underlying issue or revert the risky cleanup instead of forcing it through

6. **Optional `--review` pass**
   - Run a distinct reviewer pass that checks duplication, dead code, boundary violations, test coverage, and needless abstractions
   - If the reviewer finds issues, address them in a follow-up cleanup pass before closing the task

7. **Report outcome**
   - Changed files
   - Simplifications made
   - Behavior locked by tests
   - Remaining risks or slop intentionally left for a later pass
</Steps>

<Examples>
<Good>
User: "deslop this module -- too many wrappers, duplicate helpers, and dead code"
Why good: Explicit anti-slop intent with concrete cleanup smells.
</Good>

<Good>
User: "cleanup the AI slop in src/auth: remove dead code and tighten boundaries"
Why good: Cleanup/refactor request is clearly about simplification, not feature work.
</Good>

<Bad>
User: "refactor auth to support SSO"
Why bad: This is feature work disguised as refactoring, not anti-slop cleanup.
</Bad>

<Bad>
User: "clean up formatting"
Why bad: Formatting-only work does not need the full anti-slop workflow.
</Bad>
</Examples>

<Final_Report>
Always end with:
- **Changed files**
- **Simplifications**
- **Verification run**
- **Remaining risks**
</Final_Report>
