/**
 * Oh-My-Claude-Sisyphus
 *
 * A multi-agent orchestration system for the Claude Agent SDK.
 * Inspired by oh-my-opencode, reimagined for Claude Code.
 *
 * Main features:
 * - Sisyphus: Primary orchestrator that delegates to specialized subagents
 * - Parallel execution: Background agents run concurrently
 * - LSP/AST tools: IDE-like capabilities for agents
 * - Context management: Auto-injection from AGENTS.md/CLAUDE.md
 * - Continuation enforcement: Ensures tasks complete before stopping
 * - Magic keywords: Special triggers for enhanced behaviors
 */
import { loadConfig, findContextFiles, loadContextFromFiles } from './config/loader.js';
import { getAgentDefinitions, omcSystemPrompt } from './agents/definitions.js';
import { getDefaultMcpServers, toSdkMcpFormat } from './mcp/servers.js';
import { omcToolsServer, getOmcToolNames } from './mcp/omc-tools-server.js';
import { codexMcpServer } from './mcp/codex-server.js';
import { geminiMcpServer } from './mcp/gemini-server.js';
import { openclawMcpServer } from './mcp/openclaw-server.js';
import { createMagicKeywordProcessor, detectMagicKeywords } from './features/magic-keywords.js';
import { continuationSystemPromptAddition } from './features/continuation-enforcement.js';
import { createBackgroundTaskManager, shouldRunInBackground as shouldRunInBackgroundFn } from './features/background-tasks.js';
export { loadConfig, getAgentDefinitions, omcSystemPrompt };
export { getDefaultMcpServers, toSdkMcpFormat } from './mcp/servers.js';
export { lspTools, astTools, allCustomTools } from './tools/index.js';
export { omcToolsServer, omcToolNames, getOmcToolNames } from './mcp/omc-tools-server.js';
export { createMagicKeywordProcessor, detectMagicKeywords } from './features/magic-keywords.js';
export { createBackgroundTaskManager, shouldRunInBackground, getBackgroundTaskGuidance, DEFAULT_MAX_BACKGROUND_TASKS, LONG_RUNNING_PATTERNS, BLOCKING_PATTERNS } from './features/background-tasks.js';
export { 
// Auto-update constants
REPO_OWNER, REPO_NAME, GITHUB_API_URL, CLAUDE_CONFIG_DIR, VERSION_FILE, 
// Auto-update functions
getInstalledVersion, saveVersionMetadata, checkForUpdates, performUpdate, formatUpdateNotification, shouldCheckForUpdates, backgroundUpdateCheck, compareVersions } from './features/auto-update.js';
export * from './shared/types.js';
// Hooks module exports
export * from './hooks/index.js';
// Features module exports (boulder-state, context-injector)
export { BOULDER_DIR, BOULDER_FILE, BOULDER_STATE_PATH, NOTEPAD_DIR, NOTEPAD_BASE_PATH, PLANNER_PLANS_DIR, PLAN_EXTENSION, getBoulderFilePath, readBoulderState, writeBoulderState, appendSessionId, clearBoulderState, findPlannerPlans, getPlanProgress, getPlanName, createBoulderState, getPlanSummaries, hasBoulder, getActivePlanPath, 
// Context Injector
ContextCollector, contextCollector, injectPendingContext, injectContextIntoText, createContextInjectorHook } from './features/index.js';
// Agent module exports (modular agent system)
export { isGptModel, isClaudeModel, getDefaultModelForCategory, 
// Utilities
createAgentToolRestrictions, mergeAgentConfig, buildDelegationTable, buildUseAvoidSection, createEnvContext, getAvailableAgents, buildKeyTriggersSection, validateAgentConfig, deepMerge, loadAgentPrompt, 
// Individual agents with metadata (rebranded intuitive names)
architectAgent, ARCHITECT_PROMPT_METADATA, exploreAgent, EXPLORE_PROMPT_METADATA, researcherAgent, RESEARCHER_PROMPT_METADATA, executorAgent, SISYPHUS_JUNIOR_PROMPT_METADATA, designerAgent, FRONTEND_ENGINEER_PROMPT_METADATA, writerAgent, DOCUMENT_WRITER_PROMPT_METADATA, visionAgent, MULTIMODAL_LOOKER_PROMPT_METADATA, criticAgent, CRITIC_PROMPT_METADATA, analystAgent, ANALYST_PROMPT_METADATA, plannerAgent, PLANNER_PROMPT_METADATA, 
// Deprecated (backward compat - will be removed in v4.0.0)
coordinatorAgent, ORCHESTRATOR_SISYPHUS_PROMPT_METADATA } from './agents/index.js';
// Command expansion utilities for SDK integration
export { expandCommand, expandCommandPrompt, getCommand, getAllCommands, listCommands, commandExists, expandCommands, getCommandsDir } from './commands/index.js';
// Installer exports
export { install, isInstalled, getInstallInfo, isClaudeInstalled, CLAUDE_CONFIG_DIR as INSTALLER_CLAUDE_CONFIG_DIR, AGENTS_DIR, COMMANDS_DIR, VERSION as INSTALLER_VERSION } from './installer/index.js';
/**
 * Create a Sisyphus orchestration session
 *
 * This prepares all the configuration and options needed
 * to run a query with the Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import { createOmcSession } from 'oh-my-claudecode';
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * const session = createSisyphusSession();
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
export function createSisyphusSession(options) {
    // Load configuration
    const loadedConfig = options?.skipConfigLoad ? {} : loadConfig();
    const config = {
        ...loadedConfig,
        ...options?.config
    };
    // Find and load context files
    let contextAddition = '';
    if (!options?.skipContextInjection && config.features?.autoContextInjection !== false) {
        const contextFiles = findContextFiles(options?.workingDirectory);
        if (contextFiles.length > 0) {
            contextAddition = `\n\n## Project Context\n\n${loadContextFromFiles(contextFiles)}`;
        }
    }
    // Build system prompt
    let systemPrompt = omcSystemPrompt;
    // Add continuation enforcement
    if (config.features?.continuationEnforcement !== false) {
        systemPrompt += continuationSystemPromptAddition;
    }
    // Add custom system prompt
    if (options?.customSystemPrompt) {
        systemPrompt += `\n\n## Custom Instructions\n\n${options.customSystemPrompt}`;
    }
    // Add context from files
    if (contextAddition) {
        systemPrompt += contextAddition;
    }
    // Get agent definitions
    const agents = getAgentDefinitions();
    // Build MCP servers configuration
    const externalMcpServers = getDefaultMcpServers({
        exaApiKey: config.mcpServers?.exa?.apiKey,
        enableExa: config.mcpServers?.exa?.enabled,
        enableContext7: config.mcpServers?.context7?.enabled
    });
    // Build allowed tools list
    const allowedTools = [
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite'
    ];
    if (config.permissions?.allowBash !== false) {
        allowedTools.push('Bash');
    }
    if (config.permissions?.allowEdit !== false) {
        allowedTools.push('Edit');
    }
    if (config.permissions?.allowWrite !== false) {
        allowedTools.push('Write');
    }
    // Add MCP tool names
    for (const serverName of Object.keys(externalMcpServers)) {
        allowedTools.push(`mcp__${serverName}__*`);
    }
    // Add OMC custom tools in MCP format (LSP, AST, python_repl)
    const omcTools = getOmcToolNames({
        includeLsp: config.features?.lspTools !== false,
        includeAst: config.features?.astTools !== false,
        includePython: true
    });
    allowedTools.push(...omcTools);
    // Add Codex and Gemini MCP tool patterns
    allowedTools.push('mcp__x__*');
    allowedTools.push('mcp__g__*');
    allowedTools.push('mcp__oc__*');
    // Create magic keyword processor
    const processPrompt = createMagicKeywordProcessor(config.magicKeywords);
    // Initialize session state
    const state = {
        activeAgents: new Map(),
        backgroundTasks: [],
        contextFiles: findContextFiles(options?.workingDirectory)
    };
    // Create background task manager
    const backgroundTaskManager = createBackgroundTaskManager(state, config);
    return {
        queryOptions: {
            options: {
                systemPrompt,
                agents,
                mcpServers: {
                    ...toSdkMcpFormat(externalMcpServers),
                    't': omcToolsServer,
                    'x': codexMcpServer,
                    'g': geminiMcpServer,
                    'oc': openclawMcpServer
                },
                allowedTools,
                permissionMode: 'acceptEdits'
            }
        },
        state,
        config,
        processPrompt,
        detectKeywords: (prompt) => detectMagicKeywords(prompt, config.magicKeywords),
        backgroundTasks: backgroundTaskManager,
        shouldRunInBackground: (command) => shouldRunInBackgroundFn(command, backgroundTaskManager.getRunningCount(), backgroundTaskManager.getMaxTasks())
    };
}
/**
 * Quick helper to process a prompt with Sisyphus enhancements
 */
export function enhancePrompt(prompt, config) {
    const processor = createMagicKeywordProcessor(config?.magicKeywords);
    return processor(prompt);
}
/**
 * Get the system prompt for the orchestrator (for direct use)
 */
export function getOmcSystemPrompt(options) {
    let prompt = omcSystemPrompt;
    if (options?.includeContinuation !== false) {
        prompt += continuationSystemPromptAddition;
    }
    if (options?.customAddition) {
        prompt += `\n\n${options.customAddition}`;
    }
    return prompt;
}
//# sourceMappingURL=index.js.map