import { loadConfig, getPidPath } from './config.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { initialize as initSessionManager, shutdown as shutdownSessionManager } from './core/session-manager.js';
import { startDiscord, stopDiscord } from './adapters/discord/index.js';
import { startTelegram, stopTelegram } from './adapters/telegram/index.js';
import { startIpcServer, stopIpcServer } from './ipc/server.js';
import { logger } from './utils/logger.js';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

async function main(): Promise<void> {
  logger.info('ClawdCoder starting...');

  const config = loadConfig();

  // Initialize database
  initDatabase(config);
  logger.info('Database initialized');

  // Initialize session manager (recovers existing sessions)
  initSessionManager();

  // Start IPC server for MCP tools
  startIpcServer();

  // Start platform adapters
  const [discord, telegram] = await Promise.all([
    startDiscord(),
    startTelegram(),
  ]);

  if (!discord && !telegram) {
    logger.error('No platform adapters started. Configure Discord or Telegram tokens.');
    logger.info('Set CLAWDCODER_DISCORD_TOKEN or CLAWDCODER_TELEGRAM_TOKEN environment variables.');
    logger.info('Or configure via: omc omc-setup');
    process.exit(1);
  }

  logger.info('ClawdCoder started', {
    discord: !!discord,
    telegram: !!telegram,
  });

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);

    stopDiscord();
    stopTelegram();
    stopIpcServer();
    shutdownSessionManager();
    closeDatabase();
    logger.close();

    // Clean up PID file
    const pidPath = getPidPath();
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep process running
  process.stdin.resume();
}

main().catch((error) => {
  logger.error('Fatal error', { error: String(error) });
  process.exit(1);
});
