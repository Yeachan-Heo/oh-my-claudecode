/**
 * Oh-My-ClaudeCode
 *
 * A multi-agent orchestration system for the Claude Agent SDK.
 * Inspired by oh-my-opencode, reimagined for Claude Code.
 *
 * Main features:
 * - OMC: Primary orchestrator that delegates to specialized subagents
 * - Parallel execution: Background agents run concurrently
 * - LSP/AST tools: IDE-like capabilities for agents
 * - Context management: Auto-injection from AGENTS.md/CLAUDE.md
 * - Continuation enforcement: Ensures tasks complete before stopping
 * - Magic keywords: Special triggers for enhanced behaviors
 */
import { loadConfig } from './config/loader.js';
import { getAgentDefinitions, omcSystemPrompt } from './agents/definitions.js';
import { type BackgroundTaskManager, type TaskExecutionDecision } from './features/background-tasks.js';
import type { PluginConfig, SessionState } from './shared/types.js';
export { loadConfig, getAgentDefinitions, omcSystemPrompt };
export { getDefaultMcpServers, toSdkMcpFormat } from './mcp/servers.js';
export { lspTools, astTools, allCustomTools } from './tools/index.js';
export { omcToolsServer, omcToolNames, getOmcToolNames } from './mcp/omc-tools-server.js';
export { createMagicKeywordProcessor, detectMagicKeywords } from './features/magic-keywords.js';
export { createBackgroundTaskManager, shouldRunInBackground, getBackgroundTaskGuidance, DEFAULT_MAX_BACKGROUND_TASKS, LONG_RUNNING_PATTERNS, BLOCKING_PATTERNS, type BackgroundTaskManager, type TaskExecutionDecision } from './features/background-tasks.js';
export { type VersionMetadata, type ReleaseInfo, type UpdateCheckResult, type UpdateResult, REPO_OWNER, REPO_NAME, GITHUB_API_URL, CLAUDE_CONFIG_DIR, VERSION_FILE, getInstalledVersion, saveVersionMetadata, checkForUpdates, performUpdate, formatUpdateNotification, shouldCheckForUpdates, backgroundUpdateCheck, compareVersions } from './features/auto-update.js';
export * from './shared/types.js';
export * from './hooks/index.js';
export { type BoulderState, type PlanProgress, type PlanSummary, BOULDER_DIR, BOULDER_FILE, BOULDER_STATE_PATH, NOTEPAD_DIR, NOTEPAD_BASE_PATH, PLANNER_PLANS_DIR, PLAN_EXTENSION, getBoulderFilePath, readBoulderState, writeBoulderState, appendSessionId, clearBoulderState, findPlannerPlans, getPlanProgress, getPlanName, createBoulderState, getPlanSummaries, hasBoulder, getActivePlanPath, ContextCollector, contextCollector, injectPendingContext, injectContextIntoText, createContextInjectorHook, type ContextSourceType, type ContextPriority, type ContextEntry, type RegisterContextOptions, type PendingContext, type MessageContext, type OutputPart, type InjectionStrategy, type InjectionResult } from './features/index.js';
export { type ModelType, type AgentCost, type AgentCategory, type DelegationTrigger, type AgentPromptMetadata, type AgentConfig, type FullAgentConfig, type AgentOverrideConfig, type AgentOverrides, type AgentFactory, type AvailableAgent, isGptModel, isClaudeModel, getDefaultModelForCategory, createAgentToolRestrictions, mergeAgentConfig, buildDelegationTable, buildUseAvoidSection, createEnvContext, getAvailableAgents, buildKeyTriggersSection, validateAgentConfig, deepMerge, loadAgentPrompt, architectAgent, ARCHITECT_PROMPT_METADATA, exploreAgent, EXPLORE_PROMPT_METADATA, DOCUMENT_SPECIALIST_PROMPT_METADATA, executorAgent, EXECUTOR_PROMPT_METADATA, designerAgent, FRONTEND_ENGINEER_PROMPT_METADATA, writerAgent, DOCUMENT_WRITER_PROMPT_METADATA, criticAgent, CRITIC_PROMPT_METADATA, analystAgent, ANALYST_PROMPT_METADATA, plannerAgent, PLANNER_PROMPT_METADATA, } from './agents/index.js';
/** @deprecated Use documentSpecialistAgent instead */
export { documentSpecialistAgent as researcherAgent } from './agents/document-specialist.js';
export { expandCommand, expandCommandPrompt, getCommand, getAllCommands, listCommands, commandExists, expandCommands, getCommandsDir, type CommandInfo, type ExpandedCommand } from './commands/index.js';
export { install, isInstalled, getInstallInfo, isClaudeInstalled, CLAUDE_CONFIG_DIR as INSTALLER_CLAUDE_CONFIG_DIR, AGENTS_DIR, COMMANDS_DIR, VERSION as INSTALLER_VERSION, type InstallResult, type InstallOptions } from './installer/index.js';
/**
 * Options for creating a OMC session
 */
export interface OmcOptions {
    /** Custom configuration (merged with loaded config) */
    config?: Partial<PluginConfig>;
    /** Working directory (default: process.cwd()) */
    workingDirectory?: string;
    /** Skip loading config files */
    skipConfigLoad?: boolean;
    /** Skip context file injection */
    skipContextInjection?: boolean;
    /** Custom system prompt addition */
    customSystemPrompt?: string;
    /** API key (default: from ANTHROPIC_API_KEY env) */
    apiKey?: string;
}
/**
 * Result of creating a OMC session
 */
export interface OmcSession {
    /** The query options to pass to Claude Agent SDK */
    queryOptions: {
        options: {
            systemPrompt: string;
            agents: Record<string, {
                description: string;
                prompt: string;
                tools?: string[];
                model?: string;
            }>;
            mcpServers: Record<string, {
                command: string;
                args: string[];
            }>;
            allowedTools: string[];
            permissionMode: string;
        };
    };
    /** Session state */
    state: SessionState;
    /** Loaded configuration */
    config: PluginConfig;
    /** Process a prompt (applies magic keywords) */
    processPrompt: (prompt: string) => string;
    /** Get detected magic keywords in a prompt */
    detectKeywords: (prompt: string) => string[];
    /** Background task manager for controlling async execution */
    backgroundTasks: BackgroundTaskManager;
    /** Check if a command should run in background (convenience method) */
    shouldRunInBackground: (command: string) => TaskExecutionDecision;
}
/**
 * Create a OMC orchestration session
 *
 * This prepares all the configuration and options needed
 * to run a query with the Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import { createOmcSession } from 'oh-my-claudecode';
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * const session = createOmcSession();
 *
 * // Use with Claude Agent SDK
 * for await (const message of query({
 *   prompt: session.processPrompt("ultrawork refactor the authentication module"),
 *   ...session.queryOptions
 * })) {
 *   console.log(message);
 * }
 * ```
 */
export declare function createOmcSession(options?: OmcOptions): OmcSession;
/**
 * Quick helper to process a prompt with OMC enhancements
 */
export declare function enhancePrompt(prompt: string, config?: PluginConfig): string;
/**
 * Get the system prompt for the orchestrator (for direct use)
 */
export declare function getOmcSystemPrompt(options?: {
    includeContinuation?: boolean;
    customAddition?: string;
}): string;
//# sourceMappingURL=index.d.ts.map