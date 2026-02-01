import type { CommandContext, CommandHandler } from '../types.js';
import { checkPermission } from '../auth/index.js';
import { logger } from '../utils/logger.js';

const handlers = new Map<string, CommandHandler>();

export function registerHandler(handler: CommandHandler): void {
  handlers.set(handler.name, handler);
  logger.debug('Registered command handler', { command: handler.name });
}

export function unregisterHandler(name: string): void {
  handlers.delete(name);
}

export async function dispatch(ctx: CommandContext): Promise<void> {
  const handler = handlers.get(ctx.command);

  if (!handler) {
    await ctx.respond({ text: `Unknown command: ${ctx.command}` });
    return;
  }

  // Check permissions
  if (handler.requiredRole && !checkPermission(ctx.user, ctx.command)) {
    await ctx.respond({ text: 'You do not have permission to use this command.' });
    return;
  }

  try {
    await handler.handler(ctx);
  } catch (error) {
    logger.error('Command handler error', { command: ctx.command, error: String(error) });
    await ctx.respond({ text: `Error: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export function getHandlers(): CommandHandler[] {
  return Array.from(handlers.values());
}

export function hasHandler(name: string): boolean {
  return handlers.has(name);
}
