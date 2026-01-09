/**
 * Oh-My-Claude-Sisyphus
 *
 * A multi-agent orchestration system for the Claude Agent SDK.
 * Port of oh-my-opencode for Claude.
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
import { getAgentDefinitions, sisyphusSystemPrompt } from './agents/definitions.js';
import { getDefaultMcpServers, toSdkMcpFormat } from './mcp/servers.js';
import { createMagicKeywordProcessor, detectMagicKeywords } from './features/magic-keywords.js';
import { continuationSystemPromptAddition } from './features/continuation-enforcement.js';
import type { PluginConfig, SessionState } from './shared/types.js';

export { loadConfig, getAgentDefinitions, sisyphusSystemPrompt };
export { getDefaultMcpServers, toSdkMcpFormat } from './mcp/servers.js';
export { lspTools, astTools, allCustomTools } from './tools/index.js';
export { createMagicKeywordProcessor, detectMagicKeywords } from './features/magic-keywords.js';
export * from './shared/types.js';

// Command expansion utilities for SDK integration
export {
  expandCommand,
  expandCommandPrompt,
  getCommand,
  getAllCommands,
  listCommands,
  commandExists,
  expandCommands,
  getCommandsDir,
  type CommandInfo,
  type ExpandedCommand
} from './commands/index.js';

/**
 * Options for creating a Sisyphus session
 */
export interface SisyphusOptions {
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
 * Result of creating a Sisyphus session
 */
export interface SisyphusSession {
  /** The query options to pass to Claude Agent SDK */
  queryOptions: {
    options: {
      systemPrompt: string;
      agents: Record<string, { description: string; prompt: string; tools: string[]; model?: string }>;
      mcpServers: Record<string, { command: string; args: string[] }>;
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
}

/**
 * Create a Sisyphus orchestration session
 *
 * This prepares all the configuration and options needed
 * to run a query with the Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import { createSisyphusSession } from 'oh-my-claude-sisyphus';
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
export function createSisyphusSession(options?: SisyphusOptions): SisyphusSession {
  // Load configuration
  const loadedConfig = options?.skipConfigLoad ? {} : loadConfig();
  const config: PluginConfig = {
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
  let systemPrompt = sisyphusSystemPrompt;

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
  const mcpServers = getDefaultMcpServers({
    exaApiKey: config.mcpServers?.exa?.apiKey,
    enableExa: config.mcpServers?.exa?.enabled,
    enableContext7: config.mcpServers?.context7?.enabled,
    enableGrepApp: config.mcpServers?.grepApp?.enabled
  });

  // Build allowed tools list
  const allowedTools: string[] = [
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
  for (const serverName of Object.keys(mcpServers)) {
    allowedTools.push(`mcp__${serverName}__*`);
  }

  // Create magic keyword processor
  const processPrompt = createMagicKeywordProcessor(config.magicKeywords);

  // Initialize session state
  const state: SessionState = {
    activeAgents: new Map(),
    backgroundTasks: [],
    contextFiles: findContextFiles(options?.workingDirectory)
  };

  return {
    queryOptions: {
      options: {
        systemPrompt,
        agents,
        mcpServers: toSdkMcpFormat(mcpServers),
        allowedTools,
        permissionMode: 'acceptEdits'
      }
    },
    state,
    config,
    processPrompt,
    detectKeywords: (prompt: string) => detectMagicKeywords(prompt, config.magicKeywords)
  };
}

/**
 * Quick helper to process a prompt with Sisyphus enhancements
 */
export function enhancePrompt(prompt: string, config?: PluginConfig): string {
  const processor = createMagicKeywordProcessor(config?.magicKeywords);
  return processor(prompt);
}

/**
 * Get the system prompt for Sisyphus (for direct use)
 */
export function getSisyphusSystemPrompt(options?: {
  includeContinuation?: boolean;
  customAddition?: string;
}): string {
  let prompt = sisyphusSystemPrompt;

  if (options?.includeContinuation !== false) {
    prompt += continuationSystemPromptAddition;
  }

  if (options?.customAddition) {
    prompt += `\n\n${options.customAddition}`;
  }

  return prompt;
}
