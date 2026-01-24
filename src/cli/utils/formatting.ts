export interface TableColumn {
  header: string;
  field: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  format?: (value: any) => string;
}

export function renderTable(data: any[], columns: TableColumn[]): string {
  const lines: string[] = [];

  // Header
  const headerRow = columns.map(col => {
    return padString(col.header, col.width, col.align || 'left');
  }).join(' | ');

  lines.push(headerRow);
  lines.push(columns.map(col => '-'.repeat(col.width)).join('-+-'));

  // Data rows
  for (const row of data) {
    const dataRow = columns.map(col => {
      const value = row[col.field];
      const formatted = col.format ? col.format(value) : String(value ?? '');
      return padString(formatted, col.width, col.align || 'left');
    }).join(' | ');

    lines.push(dataRow);
  }

  return lines.join('\n');
}

function padString(str: string, width: number, align: 'left' | 'right' | 'center'): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const visibleLength = stripAnsi(str).length;
  const padding = Math.max(0, width - visibleLength);

  if (align === 'right') {
    return ' '.repeat(padding) + str;
  } else if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
  } else {
    return str + ' '.repeat(padding);
  }
}

export const colors = {
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`
};

export function formatCostWithColor(cost: number): string {
  if (cost < 1.0) return colors.green(`$${cost.toFixed(4)}`);
  if (cost < 5.0) return colors.yellow(`$${cost.toFixed(4)}`);
  return colors.red(`$${cost.toFixed(4)}`);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
