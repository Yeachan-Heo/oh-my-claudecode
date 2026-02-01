import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import * as sessionManager from '../../core/session-manager.js';
import { UserRepository } from '../../db/repositories/users.js';
import { truncateOutput, wrapCodeBlock, formatSessionStatus, formatCost } from '../../utils/format.js';
import { logger } from '../../utils/logger.js';
import type { User } from '../../types.js';

const userRepo = new UserRepository();

// Slash command definitions
export const slashCommands = [
  new SlashCommandBuilder()
    .setName('cc')
    .setDescription('ClawdCoder - Claude Code session management')
    .addSubcommandGroup(group =>
      group
        .setName('session')
        .setDescription('Session management')
        .addSubcommand(sub =>
          sub
            .setName('create')
            .setDescription('Create a new Claude Code session')
            .addStringOption(opt => opt.setName('name').setDescription('Session name').setRequired(true))
            .addStringOption(opt => opt.setName('directory').setDescription('Working directory').setRequired(true))
            .addStringOption(opt => opt.setName('prompt').setDescription('Initial prompt'))
        )
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List active sessions')
        )
        .addSubcommand(sub =>
          sub
            .setName('kill')
            .setDescription('Terminate a session')
            .addStringOption(opt => opt.setName('name').setDescription('Session name or ID').setRequired(true))
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('prompt')
        .setDescription('Send a prompt to active session')
        .addStringOption(opt => opt.setName('text').setDescription('Prompt text').setRequired(true))
        .addStringOption(opt => opt.setName('session').setDescription('Session name (uses active if omitted)'))
    )
    .addSubcommand(sub =>
      sub
        .setName('output')
        .setDescription('Get session output')
        .addStringOption(opt => opt.setName('session').setDescription('Session name'))
        .addIntegerOption(opt => opt.setName('lines').setDescription('Number of lines').setMinValue(10).setMaxValue(500))
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show bot status')
    )
    .toJSON(),
];

async function getOrCreateUser(interaction: ChatInputCommandInteraction): Promise<User> {
  const discordId = interaction.user.id;
  const username = interaction.user.username;

  return userRepo.findOrCreate({ discordId, username });
}

export async function handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  const user = await getOrCreateUser(interaction);

  // Route to handler
  if (subcommandGroup === 'session') {
    switch (subcommand) {
      case 'create':
        await handleSessionCreate(interaction, user);
        break;
      case 'list':
        await handleSessionList(interaction);
        break;
      case 'kill':
        await handleSessionKill(interaction, user);
        break;
    }
  } else {
    switch (subcommand) {
      case 'prompt':
        await handlePrompt(interaction, user);
        break;
      case 'output':
        await handleOutput(interaction);
        break;
      case 'status':
        await handleStatus(interaction);
        break;
    }
  }
}

async function handleSessionCreate(interaction: ChatInputCommandInteraction, user: User): Promise<void> {
  await interaction.deferReply();

  const name = interaction.options.getString('name', true);
  const directory = interaction.options.getString('directory', true);
  const prompt = interaction.options.getString('prompt') ?? undefined;

  try {
    const session = await sessionManager.createSession({
      name,
      workingDirectory: directory,
      user,
      initialPrompt: prompt,
    });

    const embed = new EmbedBuilder()
      .setTitle('Session Created')
      .setColor(0x00ff00)
      .addFields(
        { name: 'Name', value: session.name, inline: true },
        { name: 'ID', value: session.id, inline: true },
        { name: 'Directory', value: session.workingDirectory },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSessionList(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessions = sessionManager.listActiveSessions();

  if (sessions.length === 0) {
    await interaction.reply('No active sessions.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Active Sessions')
    .setColor(0x0099ff)
    .setDescription(sessions.map(s =>
      `**${s.name}** (${s.id.slice(0, 8)})\n` +
      `${formatSessionStatus(s.status)} | ${s.workingDirectory}\n` +
      `Cost: ${formatCost(s.totalCostUsd)}`
    ).join('\n\n'))
    .setFooter({ text: `${sessions.length} session(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleSessionKill(interaction: ChatInputCommandInteraction, user: User): Promise<void> {
  const nameOrId = interaction.options.getString('name', true);

  try {
    // Try by name first, then by ID
    let session = sessionManager.getSessionByName(nameOrId);
    if (!session) {
      session = sessionManager.getSession(nameOrId);
    }

    if (!session) {
      await interaction.reply({ content: `Session "${nameOrId}" not found.`, ephemeral: true });
      return;
    }

    // Check permission (owner or admin)
    if (session.createdBy !== user.id && user.role !== 'admin') {
      await interaction.reply({ content: 'You do not have permission to kill this session.', ephemeral: true });
      return;
    }

    sessionManager.killSession(session.id);

    await interaction.reply(`Session "${session.name}" terminated.`);
  } catch (error) {
    await interaction.reply({ content: `Failed to kill session: ${error instanceof Error ? error.message : String(error)}`, ephemeral: true });
  }
}

async function handlePrompt(interaction: ChatInputCommandInteraction, user: User): Promise<void> {
  await interaction.deferReply();

  const text = interaction.options.getString('text', true);
  const sessionName = interaction.options.getString('session');

  try {
    let session;
    if (sessionName) {
      session = sessionManager.getSessionByName(sessionName) ?? sessionManager.getSession(sessionName);
    } else {
      // Get user's most recent active session
      const userSessions = sessionManager.getUserSessions(user.id).filter(s => s.status === 'active');
      session = userSessions[0];
    }

    if (!session) {
      await interaction.editReply('No active session found. Create one with `/cc session create`.');
      return;
    }

    const queuePosition = await sessionManager.sendPrompt(session.id, text);

    await interaction.editReply(`Prompt sent to **${session.name}**. Queue position: ${queuePosition}`);
  } catch (error) {
    await interaction.editReply(`Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleOutput(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const sessionName = interaction.options.getString('session');
  const lines = interaction.options.getInteger('lines') ?? 50;

  try {
    const sessions = sessionManager.listActiveSessions();
    let session;

    if (sessionName) {
      session = sessionManager.getSessionByName(sessionName) ?? sessionManager.getSession(sessionName);
    } else {
      session = sessions[0];
    }

    if (!session) {
      await interaction.editReply('No session found.');
      return;
    }

    const output = sessionManager.getOutput(session.id, lines);
    const truncated = truncateOutput(output, 'discord');

    await interaction.editReply(wrapCodeBlock(truncated));
  } catch (error) {
    await interaction.editReply(`Failed to get output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = sessionManager.getStatus();

  const uptimeSeconds = Math.floor(status.uptime / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const embed = new EmbedBuilder()
    .setTitle('ClawdCoder Status')
    .setColor(0x00ff00)
    .addFields(
      { name: 'Uptime', value: `${hours}h ${minutes}m`, inline: true },
      { name: 'Sessions', value: `${status.activeSessions}/${status.maxSessions}`, inline: true },
      { name: 'Discord', value: status.discordConnected ? '🟢 Connected' : '🔴 Disconnected', inline: true },
      { name: 'Telegram', value: status.telegramConnected ? '🟢 Connected' : '🔴 Disconnected', inline: true },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
