/**
 * Intent-based role routing for team task assignment.
 *
 * Inspects task text to infer lane intent (what kind of work is needed),
 * then maps that intent to the most appropriate worker role.
 */
export type LaneIntent = 'implementation' | 'verification' | 'review' | 'debug' | 'design' | 'docs' | 'build-fix' | 'cleanup' | 'unknown';
export interface RoleRouterResult {
    role: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
}
/** Role-to-keyword mapping for keyword-count scoring fallback */
export declare const ROLE_KEYWORDS: Record<string, RegExp[]>;
/**
 * Infer the lane intent from free-form task text.
 * Returns 'unknown' when no clear signal is found.
 */
export declare function inferLaneIntent(text: string): LaneIntent;
/**
 * Route a task to the most appropriate role based on intent and domain.
 *
 * Priority:
 * 1. build-fix → 'build-fixer' (high)
 * 2. debug → 'debugger' (high)
 * 3. docs → 'writer' (high)
 * 4. design → 'designer' (high)
 * 5. cleanup → 'code-simplifier' (high)
 * 6. review + security domain → 'security-reviewer' (high), else 'quality-reviewer' (high)
 * 7. verification → 'test-engineer' (high)
 * 8. implementation + security domain → fallbackRole (stays put)
 * 9. Keyword-count scoring for ambiguous intents
 * 10. Unknown → fallbackRole (low)
 */
export declare function routeTaskToRole(taskSubject: string, taskDescription: string, fallbackRole: string): RoleRouterResult;
//# sourceMappingURL=role-router.d.ts.map