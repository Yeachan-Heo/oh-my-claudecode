/**
 * MCP Server Module Exports
 */

export {
  createLinkupServer,
  createRefServer,
  createPlaywrightServer,
  createFilesystemServer,
  createMemoryServer,
  getDefaultMcpServers,
  toSdkMcpFormat
} from './servers.js';

export type { McpServerConfig, McpServersConfig } from './servers.js';

// OMC Tools Server - in-process MCP server for custom tools
export {
  omcToolsServer,
  omcToolNames,
  getOmcToolNames
} from './omc-tools-server.js';

// Prompt injection helper for system prompt support
export {
  resolveSystemPrompt,
  buildPromptWithSystemContext,
  VALID_AGENT_ROLES,
  getValidAgentRoles,
  isValidAgentRoleName
} from '../agents/prompt-helpers.js';
export type { AgentRole } from '../agents/prompt-helpers.js';

// Prompt persistence for external model audit trail
export {
  persistPrompt,
  persistResponse,
  getExpectedResponsePath,
  getPromptsDir,
  slugify,
  generatePromptId,
  // Job status utilities for background execution
  getStatusFilePath,
  writeJobStatus,
  readJobStatus,
  checkResponseReady,
  readCompletedResponse,
  listActiveJobs,
  cleanupStaleJobs
} from './prompt-persistence.js';
export type {
  PersistPromptOptions,
  PersistResponseOptions,
  PersistPromptResult,
  JobStatus,
  BackgroundJobMeta
} from './prompt-persistence.js';

// Job management tools for background execution
export {
  handleWaitForJob,
  handleCheckJobStatus,
  handleKillJob,
  handleListJobs,
  findJobStatusFile,
  getJobManagementToolSchemas
} from './job-management.js';

// MCP Configuration module
export {
  loadMcpConfig,
  getMcpConfig,
  clearMcpConfigCache,
  isExternalPromptAllowed,
  getOutputPathPolicy,
  getOutputRedirectDir,
  DEFAULT_MCP_CONFIG
} from './mcp-config.js';
export type { McpConfig, OutputPathPolicy } from './mcp-config.js';
