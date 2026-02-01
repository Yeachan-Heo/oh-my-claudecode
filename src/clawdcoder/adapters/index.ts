export { startDiscord, stopDiscord, getClient as getDiscordClient } from './discord/index.js';
export { startTelegram, stopTelegram, getBot as getTelegramBot } from './telegram/index.js';
export type { Platform, CommandContext, ResponseContent, CommandHandler } from './types.js';
