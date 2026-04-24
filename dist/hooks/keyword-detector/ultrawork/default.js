export const ULTRAWORK_DEFAULT_MESSAGE = `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

[CODE RED] Maximum precision required. Ultrathink before acting.

## CERTAINTY PROTOCOL

Do not implement until you understand:
- the user's exact intent
- the existing codebase pattern to follow
- which files own the behavior
- how you will verify the result

If uncertainty remains:
1. Explore the codebase in parallel
2. Gather external docs only when needed
3. Use a planner for non-trivial dependency graphs
4. Ask the user only if ambiguity still blocks safe execution

## AGENT UTILIZATION PRINCIPLES

- **Explore first**: spawn exploration work for code paths, patterns, and tests
- **Research when needed**: use document-specialist / researcher agents for external APIs and official docs
- **Plan non-trivial work**: create a dependency-aware task graph before multi-file implementation
- **Delegate by specialty**: use executor, test-engineer, writer, verifier, architect, or critic where each adds value
- **Parallelize independent work**: fire safe independent tasks simultaneously; keep dependent work sequential

## EXECUTION RULES

- **TODO**: Track every meaningful step and mark it complete immediately
- **PARALLEL**: Run independent exploration, implementation, and verification tasks in parallel where safe
- **BACKGROUND FIRST**: Use background tasks for long-running builds, installs, and test suites
- **CONCISE OUTPUTS**: Every Task/Agent result must return only a short execution summary, target under 100 words, covering what changed, files touched, verification status, and blockers
- **VERIFY**: Re-read the request before claiming completion and confirm every requirement is met

## PLANNING GATE

For non-trivial work, produce a plan that includes:
- Parallel Execution Waves
- Dependency Matrix
- critical path
- acceptance criteria
- verification steps

Do not skip planning just because the likely change feels obvious.

## VERIFICATION GUARANTEE

Nothing is done without proof.

Before reporting completion, collect evidence for:
- build/typecheck success
- relevant tests passing
- manual QA or direct feature exercise when applicable
- no new diagnostics on changed files

WITHOUT evidence = NOT verified = NOT done.

</ultrawork-mode>

---
`;
export function getDefaultUltraworkMessage() {
    return ULTRAWORK_DEFAULT_MESSAGE;
}
//# sourceMappingURL=default.js.map