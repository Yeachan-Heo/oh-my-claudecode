import { Bot, session, type Context, type SessionFlavor } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { setTelegramConnected } from '../core/session-manager.js';
import { registerCommands } from './commands.js';
import { isAdminConfigured } from '../db/users.js';

let bot: Bot<MyContext> | null = null;

interface SessionData {
  activeSessionId?: string;
}

type MyContext = Context & SessionFlavor<SessionData>;

export async function startTelegram(): Promise<Bot<MyContext> | null> {
  const config = loadConfig();

  if (!config.telegram?.enabled || !config.telegram?.token) {
    logger.info('Telegram not configured, skipping');
    return null;
  }

  const token = config.telegram.token.startsWith('$')
    ? process.env[config.telegram.token.slice(1)]
    : config.telegram.token;

  if (!token) {
    logger.warn('Telegram token not found');
    return null;
  }

  // Security: require admin configuration
  if (!isAdminConfigured()) {
    logger.error('SECURITY: No adminTelegramIds configured. Bot refusing to start.');
    logger.error('Configure adminTelegramIds via /oh-my-claudecode:omc-setup or in ~/.claude/.omc-config.json');
    return null;
  }

  bot = new Bot<MyContext>(token);

  // Session middleware
  bot.use(session({
    initial: (): SessionData => ({}),
  }));

  // Rate limiting middleware
  const rateLimitMap = new Map<string, number[]>();
  const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
  const RATE_LIMIT_MAX_COMMANDS = 10;

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      return next();
    }

    const now = Date.now();
    const userTimestamps = rateLimitMap.get(userId) || [];

    // Remove timestamps older than the window
    const recentTimestamps = userTimestamps.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    if (recentTimestamps.length >= RATE_LIMIT_MAX_COMMANDS) {
      await ctx.reply('Rate limit exceeded. Please wait.');
      return;
    }

    // Add current timestamp
    recentTimestamps.push(now);
    rateLimitMap.set(userId, recentTimestamps);

    return next();
  });

  // Register commands
  registerCommands(bot);

  // Error handler
  bot.catch((err) => {
    logger.error('Telegram bot error', { error: String(err.error) });
  });

  // Start polling
  bot.start({
    onStart: () => {
      logger.info('Telegram bot started');
      setTelegramConnected(true);
    },
  });

  return bot;
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
    setTelegramConnected(false);
    logger.info('Telegram bot stopped');
  }
}

export function getBot(): Bot<MyContext> | null {
  return bot;
}
