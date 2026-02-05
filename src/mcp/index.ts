/**
 * MCP Server Module Exports
 */

export {
  createExaServer,
  createContext7Server,
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

// Codex MCP Server - in-process MCP server for Codex CLI integration
export {
  codexMcpServer,
  codexToolNames
} from './codex-server.js';

// Gemini MCP Server - in-process MCP server for Gemini CLI integration
export {
  geminiMcpServer,
  geminiToolNames
} from './gemini-server.js';

// Prompt injection helper for system prompt support
export {
  resolveSystemPrompt,
  buildPromptWithSystemContext,
  VALID_AGENT_ROLES
} from './prompt-injection.js';
export type { AgentRole } from './prompt-injection.js';

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
