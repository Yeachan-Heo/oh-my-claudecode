const DISCORD_MAX_LENGTH = 2000;
const TELEGRAM_MAX_LENGTH = 4096;

export function truncateOutput(
  output: string,
  platform: 'discord' | 'telegram',
  preserveLines: number = 50
): string {
  const maxLength = platform === 'discord' ? DISCORD_MAX_LENGTH : TELEGRAM_MAX_LENGTH;

  if (output.length <= maxLength) {
    return output;
  }

  const lines = output.split('\n');
  const lastLines = lines.slice(-preserveLines);
  const truncated = lastLines.join('\n');

  if (truncated.length > maxLength - 50) {
    return '... (truncated)\n' + truncated.slice(-(maxLength - 50));
  }

  return '... (truncated)\n' + truncated;
}

export function wrapCodeBlock(content: string, language: string = ''): string {
  return '```' + language + '\n' + content + '\n```';
}

export function formatSessionStatus(status: string): string {
  const icons: Record<string, string> = {
    active: '🟢',
    paused: '🟡',
    terminated: '🔴',
  };
  return `${icons[status] ?? '⚪'} ${status}`;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}
