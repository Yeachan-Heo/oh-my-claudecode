// Session types
export interface Session {
  id: string;
  name: string;
  tmuxSession: string;
  tmuxWindow: number;
  claudeSessionId?: string;
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
  telegramId?: string;
  username: string;
  role: 'admin' | 'user' | 'viewer';
  createdAt: Date;
  settings?: Record<string, unknown>;
}

// Platform types
export type Platform = 'telegram';

// Command context for platform-agnostic routing
export interface CommandContext {
  command: string;
  args: Record<string, string>;
  user: User;
  platform: Platform;
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

export interface CommandHandler {
  name: string;
  description: string;
  requiredRole?: 'admin' | 'user' | 'viewer';
  handler: (ctx: CommandContext) => Promise<void>;
}

// Config types
export interface ClawdConfig {
  telegram?: {
    token?: string;
    enabled?: boolean;
  };
  defaultProjectDir?: string;
  maxSessions?: number;
  autoCleanupHours?: number;
  dbPath?: string;
}
