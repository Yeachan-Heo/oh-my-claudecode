/**
 * Shared types for Oh-My-Claude-Sisyphus
 */

export type ModelType = 'sonnet' | 'opus' | 'haiku' | 'inherit';

export interface AgentConfig {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: ModelType;
}

export interface PluginConfig {
  // Agent model overrides
  agents?: {
    sisyphus?: { model?: string };
    architect?: { model?: string; enabled?: boolean };
    researcher?: { model?: string };
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
    grepApp?: { enabled?: boolean };
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
