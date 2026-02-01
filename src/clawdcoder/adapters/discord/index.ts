import { Client, GatewayIntentBits, REST, Routes, Events } from 'discord.js';
import { loadConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { setDiscordConnected } from '../../core/session-manager.js';
import { handleInteraction } from './commands.js';
import { slashCommands } from './commands.js';

let client: Client | null = null;

export async function startDiscord(): Promise<Client | null> {
  const config = loadConfig();

  if (!config.discord?.enabled || !config.discord?.token) {
    logger.info('Discord not configured, skipping');
    return null;
  }

  const token = config.discord.token.startsWith('$')
    ? process.env[config.discord.token.slice(1)]
    : config.discord.token;

  if (!token) {
    logger.warn('Discord token not found');
    return null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.on(Events.ClientReady, async (readyClient) => {
    logger.info('Discord bot ready', { username: readyClient.user.tag });
    setDiscordConnected(true);

    // Register slash commands
    try {
      const rest = new REST().setToken(token);
      await rest.put(
        Routes.applicationCommands(readyClient.user.id),
        { body: slashCommands },
      );
      logger.info('Registered Discord slash commands');
    } catch (error) {
      logger.error('Failed to register slash commands', { error: String(error) });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await handleInteraction(interaction);
    } catch (error) {
      logger.error('Error handling interaction', { error: String(error) });

      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);

      await reply({ content: 'An error occurred while processing your command.', ephemeral: true });
    }
  });

  client.on(Events.Error, (error) => {
    logger.error('Discord client error', { error: String(error) });
  });

  client.on(Events.ShardDisconnect, () => {
    setDiscordConnected(false);
    logger.warn('Discord disconnected');
  });

  await client.login(token);

  return client;
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    setDiscordConnected(false);
    logger.info('Discord client stopped');
  }
}

export function getClient(): Client | null {
  return client;
}
