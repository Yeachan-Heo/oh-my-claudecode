/**
 * Shared types for Oh-My-ClaudeCode
 */
export type ModelType = "sonnet" | "opus" | "haiku" | "inherit";
export interface AgentConfig {
    name: string;
    description: string;
    prompt: string;
    /** Tools the agent can use (optional - all tools allowed by default if omitted) */
    tools?: string[];
    /** Tools explicitly disallowed for this agent */
    disallowedTools?: string[];
    model?: string;
    defaultModel?: string;
}
export interface PluginConfig {
    agents?: {
        omc?: {
            model?: string;
        };
        explore?: {
            model?: string;
        };
        analyst?: {
            model?: string;
        };
        planner?: {
            model?: string;
        };
        architect?: {
            model?: string;
        };
        debugger?: {
            model?: string;
        };
        executor?: {
            model?: string;
        };
        verifier?: {
            model?: string;
        };
        securityReviewer?: {
            model?: string;
        };
        codeReviewer?: {
            model?: string;
        };
        testEngineer?: {
            model?: string;
        };
        designer?: {
            model?: string;
        };
        writer?: {
            model?: string;
        };
        qaTester?: {
            model?: string;
        };
        scientist?: {
            model?: string;
        };
        tracer?: {
            model?: string;
        };
        gitMaster?: {
            model?: string;
        };
        codeSimplifier?: {
            model?: string;
        };
        critic?: {
            model?: string;
        };
        documentSpecialist?: {
            model?: string;
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
    companyContext?: {
        tool?: string;
        onError?: "warn" | "silent" | "fail";
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
        defaultTier?: "LOW" | "MEDIUM" | "HIGH";
        /**
         * Force all agents to inherit the parent model instead of using OMC model routing.
         * When true, the `model` parameter is stripped from all Task/Agent calls so agents use
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
            tier: "LOW" | "MEDIUM" | "HIGH";
            reason: string;
        }>;
        /**
         * Model alias overrides.
         *
         * Maps agent-definition model tier names to replacement values.
         * Checked AFTER explicit model params (highest priority) but BEFORE
         * agent-definition defaults (lowest priority).
         *
         * Use cases:
         * - `{ haiku: 'inherit' }` — haiku agents inherit the parent model
         *   (useful on non-Anthropic backends without the nuclear forceInherit)
         * - `{ haiku: 'sonnet' }` — promote all haiku agents to sonnet tier
         *
         * Env: OMC_MODEL_ALIAS_HAIKU, OMC_MODEL_ALIAS_SONNET, OMC_MODEL_ALIAS_OPUS
         */
        modelAliases?: Partial<Record<"haiku" | "sonnet" | "opus", ModelType>>;
        /** Keywords that force escalation to higher tier */
        escalationKeywords?: string[];
        /** Keywords that suggest lower tier */
        simplificationKeywords?: string[];
    };
    externalModels?: ExternalModelsConfig;
    delegationRouting?: DelegationRoutingConfig;
    team?: TeamConfigBlock;
    planOutput?: {
        /** Relative directory for generated plan artifacts. Default: .omc/plans */
        directory?: string;
        /** Filename template. Supported tokens: {{name}}, {{kind}}. Default: {{name}}.md */
        filenameTemplate?: string;
    };
    startupCodebaseMap?: {
        /** Enable codebase map injection on session start. Default: true */
        enabled?: boolean;
        /** Maximum files to include in the map. Default: 200 */
        maxFiles?: number;
        /** Maximum directory depth to scan. Default: 4 */
        maxDepth?: number;
    };
    guards?: {
        factcheck?: {
            enabled?: boolean;
            mode?: "strict" | "declared" | "manual" | "quick";
            strict_project_patterns?: string[];
            forbidden_path_prefixes?: string[];
            forbidden_path_substrings?: string[];
            readonly_command_prefixes?: string[];
            warn_on_cwd_mismatch?: boolean;
            enforce_cwd_parity_in_quick?: boolean;
            warn_on_unverified_gates?: boolean;
            warn_on_unverified_gates_when_no_source_files?: boolean;
        };
        sentinel?: {
            enabled?: boolean;
            readiness?: {
                min_pass_rate?: number;
                max_timeout_rate?: number;
                max_warn_plus_fail_rate?: number;
                min_reason_coverage_rate?: number;
            };
        };
    };
    teleport?: {
        /** Reuse parent repo node_modules via symlink when package.json matches. Default: true */
        symlinkNodeModules?: boolean;
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
    promptPrerequisites?: {
        /** Enable parsing + blocking gate injection for prerequisite sections. Default: true */
        enabled?: boolean;
        /** Extensible heading aliases grouped by semantic section kind. */
        sectionNames?: {
            memory?: string[];
            skills?: string[];
            verifyFirst?: string[];
            context?: string[];
        };
        /** Tool names denied until prerequisites are satisfied. */
        blockingTools?: string[];
        /** Execution keywords that activate the gate. */
        executionKeywords?: string[];
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
    status: "idle" | "running" | "completed" | "error";
    lastMessage?: string;
    startTime?: number;
}
export interface BackgroundTask {
    id: string;
    agentName: string;
    prompt: string;
    status: "pending" | "running" | "completed" | "error";
    result?: string;
    error?: string;
}
export interface MagicKeyword {
    triggers: string[];
    action: (prompt: string, agentName?: string, modelId?: string) => string;
    description: string;
}
export interface HookDefinition {
    event: "PreToolUse" | "PostToolUse" | "Stop" | "SessionStart" | "SessionEnd" | "UserPromptSubmit";
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
export type ExternalModelProvider = "codex" | "gemini";
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
    onModelFailure: "provider_chain" | "cross_provider" | "claude_only";
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
export type DelegationProvider = "claude"
/** Use /team to coordinate Codex CLI workers in tmux panes. */
 | "codex"
/** Use /team to coordinate Gemini CLI workers in tmux panes. */
 | "gemini";
/** Tool type for delegation routing — only Claude Task is supported. */
export type DelegationTool = "Task";
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
/** Canonical role names accepted in `team.roleRouting` (source of truth). */
export declare const CANONICAL_TEAM_ROLES: readonly ["orchestrator", "planner", "analyst", "architect", "executor", "debugger", "critic", "code-reviewer", "security-reviewer", "test-engineer", "designer", "writer", "code-simplifier", "explore", "document-specialist"];
export type CanonicalTeamRole = typeof CANONICAL_TEAM_ROLES[number];
/** Provider for /team role routing. */
export type TeamRoleProvider = 'claude' | 'codex' | 'gemini';
/** Tier name accepted in role-assignment `model` field. */
export type TeamRoleTier = 'HIGH' | 'MEDIUM' | 'LOW';
/** Known agent names derived from `buildDefaultConfig().agents` keys in src/config/loader.ts. */
export declare const KNOWN_AGENT_NAMES: readonly ["omc", "explore", "analyst", "planner", "architect", "debugger", "executor", "verifier", "securityReviewer", "codeReviewer", "testEngineer", "designer", "writer", "qaTester", "scientist", "tracer", "gitMaster", "codeSimplifier", "critic", "documentSpecialist"];
export type KnownAgentName = typeof KNOWN_AGENT_NAMES[number];
/** User-facing per-role spec in `team.roleRouting`. */
export interface TeamRoleAssignmentSpec {
    provider?: TeamRoleProvider;
    /** Tier name ('HIGH' | 'MEDIUM' | 'LOW') or explicit model ID. */
    model?: TeamRoleTier | string;
    agent?: KnownAgentName;
}
/** Orchestrator is pinned to claude; only `model` is user-configurable. */
export type OrchestratorSpec = Pick<TeamRoleAssignmentSpec, 'model'>;
/** Cost mode reserved for future downgrade behavior (no implementation yet). */
export type TeamCostMode = 'normal' | 'downgrade';
/** Ops-level knobs for `/team`. */
export interface TeamOpsConfig {
    maxAgents?: number;
    defaultAgentType?: TeamRoleProvider;
    monitorIntervalMs?: number;
    shutdownTimeoutMs?: number;
    costMode?: TeamCostMode;
}
/** `team` config block in PluginConfig. */
export interface TeamConfigBlock {
    ops?: TeamOpsConfig;
    roleRouting?: Partial<Record<CanonicalTeamRole, TeamRoleAssignmentSpec>> & {
        orchestrator?: OrchestratorSpec;
    };
}
/** Concrete resolved per-role assignment stored in `TeamConfig.resolved_routing`. */
export interface RoleAssignment {
    provider: TeamRoleProvider;
    /** Resolved model ID (tier names expanded to explicit model strings). */
    model: string;
    agent: KnownAgentName;
}
//# sourceMappingURL=types.d.ts.map