/**
 * Issue #595: Consensus mode execution handoff regression tests
 * Issue #600: User feedback step between Planner and Architect/Critic
 * Issue #999: Structured deliberation protocol (RALPLAN-DR)
 *
 * Verifies that the plan skill's consensus mode (ralplan) mandates:
 * 1. Structured AskUserQuestion for approval (not plain text)
 * 2. Explicit Skill("oh-my-claudecode:ralph") invocation on approval
 * 3. Prohibition of direct implementation from the planning agent
 * 4. User feedback step after Planner but before Architect/Critic (#600)
 * 5. RALPLAN-DR short mode and deliberate mode requirements (#999)
 *
 * Also verifies that non-consensus modes (interview, direct, review) are unaffected.
 */
export {};
//# sourceMappingURL=consensus-execution-handoff.test.d.ts.map