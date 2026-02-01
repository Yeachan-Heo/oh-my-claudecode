import { Bot, type Context, InlineKeyboard } from 'grammy';
import * as sessionManager from '../core/session-manager.js';
import { UserRepository } from '../db/users.js';
import { truncateOutput, wrapCodeBlock, formatSessionStatus, formatCost } from '../utils/format.js';
import { logger } from '../utils/logger.js';
import { validateWorkingDirectory } from '../utils/validation.js';
import type { User } from '../types.js';

type RequiredRole = 'public' | 'user' | 'admin';

const COMMAND_ROLES: Record<string, RequiredRole> = {
  // Commands
  'start': 'public',
  'status': 'public',
  'session': 'admin',
  'create': 'admin',
  'kill': 'admin',
  'prompt': 'user',
  'output': 'user',
  // Callback queries (prefixes for pattern matching)
  'session:list': 'public',
  'session:create': 'admin',
  'session:switch': 'user',
  'session:kill': 'admin',
  'switch': 'user',  // for switch:* callback pattern
  // Note: kill:* callbacks use 'session:kill' role which maps to admin
};

const userRepo = new UserRepository();

interface SessionData {
  activeSessionId?: string;
}

type MyContext = Context & { session: SessionData };

async function getOrCreateUser(ctx: MyContext): Promise<User> {
  const telegramId = ctx.from?.id.toString();
  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Unknown';

  if (!telegramId) {
    throw new Error('No user ID in context');
  }

  return userRepo.findOrCreate({ telegramId, username });
}

async function checkAuthorization(ctx: MyContext, commandOrAction: string): Promise<boolean> {
  const key = commandOrAction.includes(':') && !COMMAND_ROLES[commandOrAction]
    ? commandOrAction.split(':')[0]
    : commandOrAction;

  const requiredRole = COMMAND_ROLES[key] ?? 'admin';

  if (requiredRole === 'public') {
    return true;
  }

  try {
    const user = await getOrCreateUser(ctx);

    if (requiredRole === 'admin' && user.role !== 'admin') {
      await ctx.reply('⛔ Unauthorized: Admin role required for this action.');
      return false;
    }

    if (requiredRole === 'user' && user.role !== 'admin' && user.role !== 'user') {
      await ctx.reply('⛔ Unauthorized: User role required for this action.');
      return false;
    }

    return true;
  } catch {
    await ctx.reply('⛔ Authorization failed.');
    return false;
  }
}

export function registerCommands(bot: Bot<MyContext>): void {
  // Start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🤖 *OMC Monkey* - Claude Code Session Manager\n\n' +
      'Commands:\n' +
      '/session - Manage sessions\n' +
      '/prompt <text> - Send prompt to active session\n' +
      '/output - Get session output\n' +
      '/status - Bot status\n\n' +
      'Use /session to create your first Claude Code session!',
      { parse_mode: 'Markdown' }
    );
  });

  // Session command with inline keyboard
  bot.command('session', async (ctx) => {
    if (!(await checkAuthorization(ctx, 'session'))) return;
    const keyboard = new InlineKeyboard()
      .text('📝 Create', 'session:create')
      .text('📋 List', 'session:list')
      .row()
      .text('🔌 Switch', 'session:switch')
      .text('🛑 Kill', 'session:kill');

    await ctx.reply('Session Management:', { reply_markup: keyboard });
  });

  // Prompt command
  bot.command('prompt', async (ctx) => {
    if (!(await checkAuthorization(ctx, 'prompt'))) return;
    const text = ctx.match;

    if (!text) {
      await ctx.reply('Usage: /prompt <your prompt text>');
      return;
    }

    const MAX_PROMPT_LENGTH = 100 * 1024; // 100KB
    if (text.length > MAX_PROMPT_LENGTH) {
      await ctx.reply(`Prompt too long (${text.length} chars). Maximum is ${MAX_PROMPT_LENGTH} chars.`);
      return;
    }

    try {
      const user = await getOrCreateUser(ctx);

      // Get active session from session data or user's most recent
      let sessionId = ctx.session.activeSessionId;

      if (!sessionId) {
        const userSessions = sessionManager.getUserSessions(user.id).filter(s => s.status === 'active');
        if (userSessions.length === 0) {
          await ctx.reply('No active session. Use /session to create one.');
          return;
        }
        sessionId = userSessions[0].id;
        ctx.session.activeSessionId = sessionId;
      }

      const session = sessionManager.getSession(sessionId, user);
      if (!session || session.status !== 'active') {
        await ctx.reply('Session no longer active. Use /session to create a new one.');
        ctx.session.activeSessionId = undefined;
        return;
      }

      const queuePos = await sessionManager.sendPrompt(sessionId, text);
      await ctx.reply(`Sent to *${session.name}* (queue: ${queuePos})`, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Output command
  bot.command('output', async (ctx) => {
    if (!(await checkAuthorization(ctx, 'output'))) return;
    try {
      const user = await getOrCreateUser(ctx);

      let sessionId = ctx.session.activeSessionId;

      if (!sessionId) {
        const userSessions = sessionManager.getUserSessions(user.id).filter(s => s.status === 'active');
        if (userSessions.length === 0) {
          await ctx.reply('No active session.');
          return;
        }
        sessionId = userSessions[0].id;
      }

      const session = sessionManager.getSession(sessionId, user);
      if (!session) {
        await ctx.reply('Session not found.');
        return;
      }

      const output = sessionManager.getOutput(sessionId, 50);
      const truncated = truncateOutput(output);

      await ctx.reply(`*${session.name}* output:\n${wrapCodeBlock(truncated)}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Status command
  bot.command('status', async (ctx) => {
    const status = sessionManager.getStatus();

    const uptimeSeconds = Math.floor(status.uptime / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const telegramIcon = status.telegramConnected ? '🟢' : '🔴';

    await ctx.reply(
      '🤖 *OMC Monkey Status*\n\n' +
      `⏱ Uptime: ${hours}h ${minutes}m\n` +
      `📊 Sessions: ${status.activeSessions}/${status.maxSessions}\n\n` +
      `${telegramIcon} Telegram`,
      { parse_mode: 'Markdown' }
    );
  });

  // Callback query handlers
  bot.callbackQuery('session:list', async (ctx) => {
    await ctx.answerCallbackQuery();

    const sessions = sessionManager.listActiveSessions();

    if (sessions.length === 0) {
      await ctx.editMessageText('No active sessions.\n\nUse "Create" to start a new session.');
      return;
    }

    const text = sessions.map(s =>
      `*${s.name}* (${s.id.slice(0, 8)})\n` +
      `${formatSessionStatus(s.status)} | ${formatCost(s.totalCostUsd)}`
    ).join('\n\n');

    await ctx.editMessageText(`Active Sessions:\n\n${text}`, { parse_mode: 'Markdown' });
  });

  bot.callbackQuery('session:create', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await checkAuthorization(ctx, 'session:create'))) return;
    await ctx.editMessageText(
      'To create a session, use:\n\n' +
      '/create <name> <directory>\n\n' +
      'Example:\n' +
      '/create myproject /home/user/myproject'
    );
  });

  bot.callbackQuery('session:switch', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await checkAuthorization(ctx, 'session:switch'))) return;

    try {
      const user = await getOrCreateUser(ctx);
      const sessions = sessionManager.getUserSessions(user.id).filter(s => s.status === 'active');

      if (sessions.length === 0) {
        await ctx.editMessageText('No sessions to switch to.');
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const session of sessions) {
        keyboard.text(session.name, `switch:${session.id}`).row();
      }

      await ctx.editMessageText('Select session:', { reply_markup: keyboard });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.callbackQuery('session:kill', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await checkAuthorization(ctx, 'session:kill'))) return;

    try {
      const user = await getOrCreateUser(ctx);
      const sessions = sessionManager.getUserSessions(user.id).filter(s => s.status === 'active');

      if (sessions.length === 0) {
        await ctx.editMessageText('No sessions to kill.');
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const session of sessions) {
        keyboard.text(`🛑 ${session.name}`, `kill:${session.id}`).row();
      }

      await ctx.editMessageText('Select session to terminate:', { reply_markup: keyboard });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Switch session handler
  bot.callbackQuery(/^switch:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await checkAuthorization(ctx, 'switch'))) return;

    try {
      const user = await getOrCreateUser(ctx);
      const sessionId = ctx.match[1];
      const session = sessionManager.getSession(sessionId, user);

      if (!session) {
        await ctx.editMessageText('Session not found.');
        return;
      }

      ctx.session.activeSessionId = sessionId;
      await ctx.editMessageText(`Switched to *${session.name}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Kill session handler
  bot.callbackQuery(/^kill:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await checkAuthorization(ctx, 'session:kill'))) return;

    const sessionId = ctx.match[1];

    try {
      const user = await getOrCreateUser(ctx);
      const session = sessionManager.getSession(sessionId, user);
      if (!session) {
        await ctx.editMessageText('Session not found.');
        return;
      }

      sessionManager.killSession(sessionId, user);

      if (ctx.session.activeSessionId === sessionId) {
        ctx.session.activeSessionId = undefined;
      }

      await ctx.editMessageText(`Session *${session.name}* terminated.`, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Create session command
  bot.command('create', async (ctx) => {
    if (!(await checkAuthorization(ctx, 'create'))) return;
    const args = ctx.match?.split(' ');

    if (!args || args.length < 2) {
      await ctx.reply('Usage: /create <name> <directory> [prompt]');
      return;
    }

    const [name, directory, ...promptParts] = args;
    const initialPrompt = promptParts.length > 0 ? promptParts.join(' ') : undefined;

    try {
      const user = await getOrCreateUser(ctx);
      const validatedDir = validateWorkingDirectory(directory);

      const session = await sessionManager.createSession({
        name,
        workingDirectory: validatedDir,
        user,
        initialPrompt,
      });

      ctx.session.activeSessionId = session.id;

      await ctx.reply(
        `✅ Session *${session.name}* created!\n\n` +
        `📁 Directory: ${session.workingDirectory}\n` +
        `🆔 ID: \`${session.id}\`\n\n` +
        `Use /prompt to send commands.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
