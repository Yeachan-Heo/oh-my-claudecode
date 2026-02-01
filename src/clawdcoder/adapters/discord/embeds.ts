import { EmbedBuilder } from 'discord.js';
import type { Session } from '../../types.js';
import { formatSessionStatus, formatCost, formatTokens } from '../../utils/format.js';

export function createSessionEmbed(session: Session): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Session: ${session.name}`)
    .setColor(session.status === 'active' ? 0x00ff00 : session.status === 'paused' ? 0xffff00 : 0xff0000)
    .addFields(
      { name: 'ID', value: session.id, inline: true },
      { name: 'Status', value: formatSessionStatus(session.status), inline: true },
      { name: 'Directory', value: session.workingDirectory },
      { name: 'Cost', value: formatCost(session.totalCostUsd), inline: true },
      { name: 'Tokens', value: `${formatTokens(session.totalInputTokens)} in / ${formatTokens(session.totalOutputTokens)} out`, inline: true },
    )
    .setTimestamp(session.lastActiveAt);
}

export function createErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Error')
    .setColor(0xff0000)
    .setDescription(message)
    .setTimestamp();
}

export function createOutputEmbed(sessionName: string, output: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Output: ${sessionName}`)
    .setColor(0x0099ff)
    .setDescription('```\n' + output + '\n```')
    .setTimestamp();
}
