// Session types
export interface Session {
  id: string;
  name: string;
  tmuxSession: string;
  tmuxWindow: number;
  claudeSessionId?: string;
  projectId?: string;
  workingDirectory: string;
  status: 'active' | 'paused' | 'terminated';
  createdBy: string;
  createdAt: Date;
  lastActiveAt: Date;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  metadata?: Record<string, unknown>;
}

// User types
export interface User {
  id: string;
  discordId?: string;
  telegramId?: string;
  username: string;
  role: 'admin' | 'user' | 'viewer';
  createdAt: Date;
  settings?: Record<string, unknown>;
}

// Project types
export interface Project {
  id: string;
  name: string;
  directory: string;
  gitRepo?: string;
  defaultBranch: string;
  createdBy: string;
  createdAt: Date;
  settings?: Record<string, unknown>;
}

// Permission types
export interface Permission {
  id: number;
  userId: string;
  projectId: string;
  level: 'admin' | 'write' | 'read';
  grantedBy: string;
  grantedAt: Date;
}

// Cost log types
export interface CostLogEntry {
  id: number;
  sessionId: string;
  userId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: Date;
}

// Command context for platform-agnostic routing
export interface CommandContext {
  command: string;
  args: Record<string, string>;
  user: User;
  platform: 'discord' | 'telegram';
  respond: (content: ResponseContent) => Promise<void>;
  streamUpdate: (content: string) => Promise<void>;
  sessionId?: string;
}

export interface ResponseContent {
  text?: string;
  embed?: EmbedContent;
  keyboard?: KeyboardContent;
}

export interface EmbedContent {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface KeyboardContent {
  buttons: Array<Array<{ text: string; callback: string }>>;
}

// IPC protocol types (JSON-RPC 2.0)
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string;
}

// Config types
export interface ClawdCoderConfig {
  discord?: {
    token?: string;
    enabled?: boolean;
  };
  telegram?: {
    token?: string;
    enabled?: boolean;
  };
  defaultProjectDir?: string;
  maxSessions?: number;
  autoCleanupHours?: number;
  dbPath?: string;
}
