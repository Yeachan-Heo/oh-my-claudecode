/**
 * Model Routing Types
 *
 * Type definitions for the intelligent model routing system that routes
 * sub-agent tasks to appropriate models (Opus/Sonnet/Haiku) based on
 * task complexity.
 */
import type { ModelType } from '../../shared/types.js';
/**
 * Complexity tier for task routing
 */
export type ComplexityTier = 'LOW' | 'MEDIUM' | 'HIGH';
/**
 * Model tier mapping to actual Claude models.
 *
 * Reads from environment variables (OMC_MODEL_HIGH, OMC_MODEL_MEDIUM,
 * OMC_MODEL_LOW) with built-in fallbacks. User/project config overrides
 * are applied later by the config loader.
 */
export declare const TIER_MODELS: Record<ComplexityTier, string>;
/**
 * Model tier to simple model type mapping
 */
export declare const TIER_TO_MODEL_TYPE: Record<ComplexityTier, ModelType>;
/**
 * Lexical/syntactic signals that can be extracted without model calls
 */
export interface LexicalSignals {
    /** Word count of the task prompt */
    wordCount: number;
    /** Number of file paths mentioned */
    filePathCount: number;
    /** Number of code blocks in the prompt */
    codeBlockCount: number;
    /** Contains architecture-related keywords */
    hasArchitectureKeywords: boolean;
    /** Contains debugging-related keywords */
    hasDebuggingKeywords: boolean;
    /** Contains simple search keywords */
    hasSimpleKeywords: boolean;
    /** Contains risk/critical keywords */
    hasRiskKeywords: boolean;
    /** Question depth: 'why' > 'how' > 'what' > 'where' */
    questionDepth: 'why' | 'how' | 'what' | 'where' | 'none';
    /** Has implicit requirements (statements without clear deliverables) */
    hasImplicitRequirements: boolean;
}
/**
 * Structural signals that require parsing
 */
export interface StructuralSignals {
    /** Estimated number of subtasks */
    estimatedSubtasks: number;
    /** Whether changes span multiple files */
    crossFileDependencies: boolean;
    /** Whether tests are required */
    hasTestRequirements: boolean;
    /** Domain specificity of the task */
    domainSpecificity: 'generic' | 'frontend' | 'backend' | 'infrastructure' | 'security';
    /** Whether external knowledge is needed */
    requiresExternalKnowledge: boolean;
    /** How reversible the changes are */
    reversibility: 'easy' | 'moderate' | 'difficult';
    /** Scope of impact */
    impactScope: 'local' | 'module' | 'system-wide';
}
/**
 * Context signals from session state
 */
export interface ContextSignals {
    /** Number of previous failures on this task */
    previousFailures: number;
    /** Number of conversation turns */
    conversationTurns: number;
    /** Complexity of the active plan (number of tasks) */
    planComplexity: number;
    /** Number of remaining tasks in plan */
    remainingTasks: number;
    /** Depth of agent delegation chain */
    agentChainDepth: number;
}
/**
 * Combined complexity signals
 */
export interface ComplexitySignals {
    lexical: LexicalSignals;
    structural: StructuralSignals;
    context: ContextSignals;
}
/**
 * Routing decision result
 */
export interface RoutingDecision {
    /** Selected model ID */
    model: string;
    /** Selected model type */
    modelType: ModelType;
    /** Complexity tier */
    tier: ComplexityTier;
    /** Confidence score (0-1) */
    confidence: number;
    /** Reasons for the decision */
    reasons: string[];
    /** Adapted prompt for the tier (optional) */
    adaptedPrompt?: string;
    /** Whether escalation was triggered */
    escalated: boolean;
    /** Original tier before escalation (if escalated) */
    originalTier?: ComplexityTier;
}
/**
 * Context for making routing decisions
 */
export interface RoutingContext {
    /** The task prompt to route */
    taskPrompt: string;
    /** Target agent type (if specified) */
    agentType?: string;
    /** Parent session ID for context */
    parentSession?: string;
    /** Number of previous failures */
    previousFailures?: number;
    /** Current conversation turn count */
    conversationTurns?: number;
    /** Active plan tasks count */
    planTasks?: number;
    /** Remaining plan tasks */
    remainingTasks?: number;
    /** Current agent chain depth */
    agentChainDepth?: number;
    /** Explicit model override (bypasses routing) */
    explicitModel?: ModelType;
}
/**
 * Routing rule definition
 */
export interface RoutingRule {
    /** Rule name for logging/debugging */
    name: string;
    /** Condition function to check if rule applies */
    condition: (context: RoutingContext, signals: ComplexitySignals) => boolean;
    /** Action to take if condition is true */
    action: {
        tier: ComplexityTier | 'EXPLICIT';
        reason: string;
    };
    /** Priority (higher = evaluated first) */
    priority: number;
}
/**
 * Routing configuration
 */
export interface RoutingConfig {
    /** Whether routing is enabled */
    enabled: boolean;
    /** Default tier when no rules match */
    defaultTier: ComplexityTier;
    /** Minimum tier to allow (e.g. disable LOW tier by setting minTier to MEDIUM) */
    minTier?: ComplexityTier;
    /** Whether automatic escalation is enabled */
    escalationEnabled: boolean;
    /** Maximum escalation attempts */
    maxEscalations: number;
    /** Model mapping per tier */
    tierModels: Record<ComplexityTier, string>;
    /** Agent-specific overrides */
    agentOverrides?: Record<string, {
        tier: ComplexityTier;
        reason: string;
    }>;
    /** Keywords that force escalation */
    escalationKeywords?: string[];
    /** Keywords that suggest lower tier */
    simplificationKeywords?: string[];
}
/**
 * Default routing configuration
 *
 * ALL agents are adaptive based on task complexity.
 */
export declare const DEFAULT_ROUTING_CONFIG: RoutingConfig;
/**
 * Agent categories and their default complexity tiers
 */
export declare const AGENT_CATEGORY_TIERS: Record<string, ComplexityTier>;
/**
 * Keywords for complexity detection
 */
export declare const COMPLEXITY_KEYWORDS: {
    architecture: string[];
    debugging: string[];
    simple: string[];
    risk: string[];
};
/**
 * Prompt adaptation strategies per tier
 */
export type PromptAdaptationStrategy = 'full' | 'balanced' | 'concise';
export declare const TIER_PROMPT_STRATEGIES: Record<ComplexityTier, PromptAdaptationStrategy>;
//# sourceMappingURL=types.d.ts.map