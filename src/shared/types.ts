/**
 * Shared types for Oh-My-Claude-Sisyphus
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
  // Agent model overrides
  agents?: {
    omc?: { model?: string };
    architect?: { model?: string; enabled?: boolean };
    researcher?: { model?: string };
    'document-specialist'?: { model?: string };
    explore?: { model?: string };
    frontendEngineer?: { model?: string; enabled?: boolean };
    documentWriter?: { model?: string; enabled?: boolean };
    multimodalLooker?: { model?: string; enabled?: boolean };
    // New agents from oh-my-opencode
    critic?: { model?: string; enabled?: boolean };
    analyst?: { model?: string; enabled?: boolean };
    orchestratorSisyphus?: { model?: string; enabled?: boolean };
    sisyphusJunior?: { model?: string; enabled?: boolean };
    planner?: { model?: string; enabled?: boolean };
  };

  // Feature toggles
  features?: {
    parallelExecution?: boolean;
    lspTools?: boolean;
    astTools?: boolean;
    continuationEnforcement?: boolean;
    autoContextInjection?: boolean;
  };

  // MCP server configurations
  mcpServers?: {
    exa?: { enabled?: boolean; apiKey?: string };
    context7?: { enabled?: boolean };
  };

  // Permission settings
  permissions?: {
    allowBash?: boolean;
    allowEdit?: boolean;
    allowWrite?: boolean;
    maxBackgroundTasks?: number;
  };

  // Magic keyword customization
  magicKeywords?: {
    ultrawork?: string[];
    search?: string[];
    analyze?: string[];
    ultrathink?: string[];
  };

  // Intelligent model routing configuration
  routing?: {
    /** Enable intelligent model routing */
    enabled?: boolean;
    /** Default tier when no rules match */
    defaultTier?: 'LOW' | 'MEDIUM' | 'HIGH';
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

  // External models configuration (Codex, Gemini)
  externalModels?: ExternalModelsConfig;

  // Delegation routing configuration
  delegationRouting?: DelegationRoutingConfig;

  // Task size detection configuration (issue #790)
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
export type DelegationProvider = 'claude' | 'codex' | 'gemini';

/**
 * Tool type for delegation routing
 */
export type DelegationTool = 'Task' | 'ask_codex' | 'ask_gemini';

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
