/**
 * Shared types for Oh-My-ClaudeCode
 */
export type ModelType = 'sonnet' | 'opus' | 'haiku' | 'inherit';
export interface AgentConfig {
    name: string;
    description: string;
    prompt: string;
    /** Tools the agent can use (optional - all tools allowed by default if omitted) */
    tools?: string[];
    /** Tools explicitly disallowed for this agent */
    disallowedTools?: string[];
    model?: ModelType;
    defaultModel?: ModelType;
}
export interface PluginConfig {
    agents?: {
        omc?: {
            model?: string;
        };
        architect?: {
            model?: string;
            enabled?: boolean;
        };
        researcher?: {
            model?: string;
        };
        'document-specialist'?: {
            model?: string;
        };
        explore?: {
            model?: string;
        };
        frontendEngineer?: {
            model?: string;
            enabled?: boolean;
        };
        documentWriter?: {
            model?: string;
            enabled?: boolean;
        };
        multimodalLooker?: {
            model?: string;
            enabled?: boolean;
        };
        critic?: {
            model?: string;
            enabled?: boolean;
        };
        analyst?: {
            model?: string;
            enabled?: boolean;
        };
        coordinator?: {
            model?: string;
            enabled?: boolean;
        };
        executor?: {
            model?: string;
            enabled?: boolean;
        };
        planner?: {
            model?: string;
            enabled?: boolean;
        };
    };
    features?: {
        parallelExecution?: boolean;
        lspTools?: boolean;
        astTools?: boolean;
        continuationEnforcement?: boolean;
        autoContextInjection?: boolean;
    };
    mcpServers?: {
        exa?: {
            enabled?: boolean;
            apiKey?: string;
        };
        context7?: {
            enabled?: boolean;
        };
    };
    permissions?: {
        allowBash?: boolean;
        allowEdit?: boolean;
        allowWrite?: boolean;
        maxBackgroundTasks?: number;
    };
    magicKeywords?: {
        ultrawork?: string[];
        search?: string[];
        analyze?: string[];
        ultrathink?: string[];
    };
    routing?: {
        /** Enable intelligent model routing */
        enabled?: boolean;
        /** Default tier when no rules match */
        defaultTier?: 'LOW' | 'MEDIUM' | 'HIGH';
        /**
         * Force all agents to inherit the parent model instead of using OMC model routing.
         * When true, the `model` parameter is stripped from all Task calls so agents use
         * the user's Claude Code model setting. Overrides all per-agent model recommendations.
         * Env: OMC_ROUTING_FORCE_INHERIT=true
         */
        forceInherit?: boolean;
        /** Enable automatic escalation on failure */
        escalationEnabled?: boolean;
        /** Maximum escalation attempts */
        maxEscalations?: number;
        /** Model mapping per tier */
        tierModels?: {
            LOW?: string;
            MEDIUM?: string;
            HIGH?: string;
        };
        /** Agent-specific tier overrides */
        agentOverrides?: Record<string, {
            tier: 'LOW' | 'MEDIUM' | 'HIGH';
            reason: string;
        }>;
        /** Keywords that force escalation to higher tier */
        escalationKeywords?: string[];
        /** Keywords that suggest lower tier */
        simplificationKeywords?: string[];
    };
    externalModels?: ExternalModelsConfig;
    delegationRouting?: DelegationRoutingConfig;
    startupCodebaseMap?: {
        /** Enable codebase map injection on session start. Default: true */
        enabled?: boolean;
        /** Maximum files to include in the map. Default: 200 */
        maxFiles?: number;
        /** Maximum directory depth to scan. Default: 4 */
        maxDepth?: number;
    };
    taskSizeDetection?: {
        /** Enable task-size detection to prevent over-orchestration for small tasks. Default: true */
        enabled?: boolean;
        /** Word count threshold below which a task is classified as "small". Default: 50 */
        smallWordLimit?: number;
        /** Word count threshold above which a task is classified as "large". Default: 200 */
        largeWordLimit?: number;
        /** Suppress heavy orchestration modes (ralph/autopilot/team/ultrawork) for small tasks. Default: true */
        suppressHeavyModesForSmallTasks?: boolean;
    };
}
export interface SessionState {
    sessionId?: string;
    activeAgents: Map<string, AgentState>;
    backgroundTasks: BackgroundTask[];
    contextFiles: string[];
}
export interface AgentState {
    name: string;
    status: 'idle' | 'running' | 'completed' | 'error';
    lastMessage?: string;
    startTime?: number;
}
export interface BackgroundTask {
    id: string;
    agentName: string;
    prompt: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    result?: string;
    error?: string;
}
export interface MagicKeyword {
    triggers: string[];
    action: (prompt: string) => string;
    description: string;
}
export interface HookDefinition {
    event: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit';
    matcher?: string;
    command?: string;
    handler?: (context: HookContext) => Promise<HookResult>;
}
export interface HookContext {
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    sessionId?: string;
}
export interface HookResult {
    continue: boolean;
    message?: string;
    modifiedInput?: unknown;
}
/**
 * External model provider type
 */
export type ExternalModelProvider = 'codex' | 'gemini';
/**
 * External model configuration for a specific role or task
 */
export interface ExternalModelPreference {
    provider: ExternalModelProvider;
    model: string;
}
/**
 * External models default configuration
 */
export interface ExternalModelsDefaults {
    provider?: ExternalModelProvider;
    codexModel?: string;
    geminiModel?: string;
}
/**
 * External models fallback policy
 */
export interface ExternalModelsFallbackPolicy {
    onModelFailure: 'provider_chain' | 'cross_provider' | 'claude_only';
    allowCrossProvider?: boolean;
    crossProviderOrder?: ExternalModelProvider[];
}
/**
 * External models configuration
 */
export interface ExternalModelsConfig {
    defaults?: ExternalModelsDefaults;
    rolePreferences?: Record<string, ExternalModelPreference>;
    taskPreferences?: Record<string, ExternalModelPreference>;
    fallbackPolicy?: ExternalModelsFallbackPolicy;
}
/**
 * Resolved external model result
 */
export interface ResolvedModel {
    provider: ExternalModelProvider;
    model: string;
    fallbackPolicy: ExternalModelsFallbackPolicy;
}
/**
 * Options for resolving external model
 */
export interface ResolveOptions {
    agentRole?: string;
    taskType?: string;
    explicitProvider?: ExternalModelProvider;
    explicitModel?: string;
}
/**
 * Provider type for delegation routing
 */
export type DelegationProvider = 'claude'
/** Use /team to coordinate Codex CLI workers in tmux panes. */
 | 'codex'
/** Use /team to coordinate Gemini CLI workers in tmux panes. */
 | 'gemini';
/** Tool type for delegation routing — only Claude Task is supported. */
export type DelegationTool = 'Task';
/**
 * Individual route configuration for a role
 */
export interface DelegationRoute {
    provider: DelegationProvider;
    tool: DelegationTool;
    model?: string;
    agentType?: string;
    fallback?: string[];
}
/**
 * Delegation routing configuration
 */
export interface DelegationRoutingConfig {
    roles?: Record<string, DelegationRoute>;
    defaultProvider?: DelegationProvider;
    enabled?: boolean;
}
/**
 * Result of delegation resolution
 */
export interface DelegationDecision {
    provider: DelegationProvider;
    tool: DelegationTool;
    agentOrModel: string;
    reason: string;
    fallbackChain?: string[];
}
/**
 * Options for resolveDelegation
 */
export interface ResolveDelegationOptions {
    agentRole: string;
    taskContext?: string;
    explicitTool?: DelegationTool;
    explicitModel?: string;
    config?: DelegationRoutingConfig;
}
//# sourceMappingURL=types.d.ts.map