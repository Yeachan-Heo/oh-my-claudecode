import type { User } from '../types.js';

export type Platform = 'discord' | 'telegram';

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
