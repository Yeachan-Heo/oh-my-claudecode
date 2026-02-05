/**
 * Agent v4 Tier Overlays
 *
 * Tier-specific behavior and tool modifications.
 */

import type { ComplexityTier, TierOverlay } from "./types.js";

const LOW_TIER_INSTRUCTIONS = `**Tier: LOW (Haiku) - Speed-Focused Execution**

- Focus on speed and direct execution
- Handle simple, well-defined tasks only
- Limit exploration to 5 files maximum
- Escalate to MEDIUM tier if:
  - Task requires analyzing more than 5 files
  - Complexity is higher than expected
  - Architectural decisions needed
- Prefer straightforward solutions over clever ones
- Skip deep investigation - implement what's asked`.trim();

const MEDIUM_TIER_INSTRUCTIONS = `**Tier: MEDIUM (Sonnet) - Balanced Execution**

- Balance thoroughness with efficiency
- Can explore up to 20 files
- Handle moderate complexity tasks
- Consult architect agent for architectural decisions
- Escalate to HIGH tier if:
  - Task requires deep architectural changes
  - System-wide refactoring needed
  - Complex debugging across many components
- Consider edge cases but don't over-engineer
- Document non-obvious decisions`.trim();

const HIGH_TIER_INSTRUCTIONS =
  `**Tier: HIGH (Opus) - Excellence-Focused Execution**

- Prioritize correctness and code quality above all
- Full codebase exploration allowed
- Make architectural decisions confidently
- Handle complex, ambiguous, or system-wide tasks
- Consider:
  - Long-term maintainability
  - Edge cases and error scenarios
  - Performance implications
  - Security considerations
- Thoroughly document reasoning
- No escalation needed - you are the top tier`.trim();

/**
 * Tier overlay configuration map.
 */
export const TIER_OVERLAYS: Record<ComplexityTier, TierOverlay> = {
  LOW: {
    tier: "LOW",
    model: "haiku",
    instructions: LOW_TIER_INSTRUCTIONS,
    maxFileExploration: 5,
    canEscalate: true,
    toolModifiers: {
      remove: [
        "WebSearch",
        "WebFetch",
        "ast_grep_search",
        "lsp_diagnostics_directory",
      ],
    },
  },
  MEDIUM: {
    tier: "MEDIUM",
    model: "sonnet",
    instructions: MEDIUM_TIER_INSTRUCTIONS,
    maxFileExploration: 20,
    canEscalate: true,
  },
  HIGH: {
    tier: "HIGH",
    model: "opus",
    instructions: HIGH_TIER_INSTRUCTIONS,
    maxFileExploration: Number.POSITIVE_INFINITY,
    canEscalate: false,
    toolModifiers: {
      add: [
        "WebSearch",
        "WebFetch",
        "ast_grep_search",
        "ast_grep_replace",
        "lsp_diagnostics_directory",
        "lsp_find_references",
      ],
    },
  },
};

/**
 * Get tier overlay details for a given tier.
 */
export function getTierOverlay(tier: ComplexityTier): TierOverlay {
  return TIER_OVERLAYS[tier];
}
