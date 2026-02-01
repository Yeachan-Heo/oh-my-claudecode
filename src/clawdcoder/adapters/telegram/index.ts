import { Bot, session, type Context, type SessionFlavor } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { setTelegramConnected } from '../../core/session-manager.js';
import { registerCommands } from './commands.js';

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

  bot = new Bot<MyContext>(token);

  // Session middleware
  bot.use(session({
    initial: (): SessionData => ({}),
  }));

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
