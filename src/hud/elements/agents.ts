/**
 * Sisyphus HUD - Agents Element
 *
 * Renders active agent count display with multiple format options:
 * - count: agents:2
 * - codes: agents:Oes (type-coded with model tier casing)
 * - detailed: agents:[architect(2m),explore,sj]
 */

import type { ActiveAgent, AgentsFormat } from '../types.js';
import { cyan, dim, RESET, getModelTierColor, getDurationColor } from '../colors.js';

const CYAN = '\x1b[36m';

// ============================================================================
// Agent Type Codes
// ============================================================================

/**
 * Single-character codes for each agent type.
 * Case indicates model tier: Uppercase = Opus, lowercase = Sonnet/Haiku
 */
const AGENT_TYPE_CODES: Record<string, string> = {
  architect: 'O',
  'architect-low': 'o',
  'architect-medium': 'o',
  explore: 'E',
  'explore-medium': 'e',
  'executor': 'S',
  'executor-low': 's',
  'executor-high': 'S',
  'designer': 'F',
  'designer-low': 'f',
  'designer-high': 'F',
  researcher: 'L',
  'researcher-low': 'l',
  'writer': 'd', // Always haiku
  planner: 'P', // Always opus
  critic: 'M', // Always opus
  analyst: 'T', // Me**t**is (M taken)
  'qa-tester': 'q', // Always sonnet
  'vision': 'v', // **V**isual (always sonnet)
};

/**
 * Get single-character code for an agent type.
 */
function getAgentCode(agentType: string, model?: string): string {
  // Extract the short name from full type (e.g., "oh-my-claudecode:architect" -> "architect")
  const parts = agentType.split(':');
  const shortName = parts[parts.length - 1] || agentType;

  // Look up the code
  let code = AGENT_TYPE_CODES[shortName];

  if (!code) {
    // Unknown agent - use first letter
    code = shortName.charAt(0).toUpperCase();
  }

  // Determine case based on model tier if code is single letter
  if (model) {
    const tier = model.toLowerCase();
    if (tier.includes('opus')) {
      code = code.toUpperCase();
    } else {
      code = code.toLowerCase();
    }
  }

  return code;
}

/**
 * Format duration for display.
 * <10s: no suffix, 10s-59s: (Xs), 1m-9m: (Xm), >=10m: !
 */
function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);

  if (seconds < 10) {
    return ''; // No suffix for very short durations
  } else if (seconds < 60) {
    return `(${seconds}s)`;
  } else if (minutes < 10) {
    return `(${minutes}m)`;
  } else {
    return '!'; // Alert for very long durations
  }
}

// ============================================================================
// Render Functions
// ============================================================================

/**
 * Render active agent count.
 * Returns null if no agents are running.
 *
 * Format: agents:2
 */
export function renderAgents(agents: ActiveAgent[]): string | null {
  const running = agents.filter((a) => a.status === 'running').length;

  if (running === 0) {
    return null;
  }

  return `agents:${CYAN}${running}${RESET}`;
}

/**
 * Sort agents by start time (freshest first, oldest last)
 */
function sortByFreshest(agents: ActiveAgent[]): ActiveAgent[] {
  return [...agents].sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
}

/**
 * Render agents with single-character type codes.
 * Uppercase = Opus tier, lowercase = Sonnet/Haiku.
 * Color-coded by model tier.
 *
 * Format: agents:Oes
 */
export function renderAgentsCoded(agents: ActiveAgent[]): string | null {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return null;
  }

  // Build coded string with colors
  const codes = running.map((a) => {
    const code = getAgentCode(a.type, a.model);
    const color = getModelTierColor(a.model);
    return `${color}${code}${RESET}`;
  });

  return `agents:${codes.join('')}`;
}

/**
 * Render agents with codes and duration indicators.
 * Shows how long each agent has been running.
 *
 * Format: agents:O(2m)es
 */
export function renderAgentsCodedWithDuration(agents: ActiveAgent[]): string | null {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return null;
  }

  const now = Date.now();

  // Build coded string with colors and durations
  const codes = running.map((a) => {
    const code = getAgentCode(a.type, a.model);
    const durationMs = now - a.startTime.getTime();
    const duration = formatDuration(durationMs);

    // Color the code by model tier
    const modelColor = getModelTierColor(a.model);

    if (duration === '!') {
      // Alert case - show exclamation in duration color
      const durationColor = getDurationColor(durationMs);
      return `${modelColor}${code}${durationColor}!${RESET}`;
    } else if (duration) {
      // Normal duration - dim the time portion
      return `${modelColor}${code}${dim(duration)}${RESET}`;
    } else {
      // No duration suffix
      return `${modelColor}${code}${RESET}`;
    }
  });

  return `agents:${codes.join('')}`;
}

/**
 * Render detailed agent list (for full mode).
 *
 * Format: agents:[architect(2m),explore,sj]
 */
export function renderAgentsDetailed(agents: ActiveAgent[]): string | null {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return null;
  }

  const now = Date.now();

  // Extract short agent type names with duration
  const names = running.map((a) => {
    // Extract last part of agent type (e.g., "oh-my-claudecode:explore" -> "explore")
    const parts = a.type.split(':');
    let name = parts[parts.length - 1] || a.type;

    // Abbreviate common names
    if (name === 'executor') name = 'sj';
    if (name === 'executor-low') name = 'sj-l';
    if (name === 'executor-high') name = 'sj-h';
    if (name === 'designer') name = 'fe';
    if (name === 'designer-low') name = 'fe-l';
    if (name === 'designer-high') name = 'fe-h';
    if (name === 'writer') name = 'doc';
    if (name === 'vision') name = 'visual';

    // Add duration if significant
    const durationMs = now - a.startTime.getTime();
    const duration = formatDuration(durationMs);

    return duration ? `${name}${duration}` : name;
  });

  return `agents:[${CYAN}${names.join(',')}${RESET}]`;
}

/**
 * Truncate description to fit in statusline.
 */
function truncateDescription(desc: string | undefined, maxLen: number = 20): string {
  if (!desc) return '...';
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen - 3) + '...';
}

/**
 * Get short agent type name.
 */
function getShortAgentName(agentType: string): string {
  const parts = agentType.split(':');
  let name = parts[parts.length - 1] || agentType;

  // Abbreviate common names
  const abbrevs: Record<string, string> = {
    'executor': 'sj',
    'executor-low': 'sj',
    'executor-high': 'sj',
    'designer': 'fe',
    'designer-low': 'fe',
    'designer-high': 'fe',
    'writer': 'doc',
    'vision': 'visual',
    'architect-low': 'architect',
    'architect-medium': 'architect',
    'explore-medium': 'explore',
    'researcher-low': 'lib',
  };

  return abbrevs[name] || name;
}

/**
 * Render agents with descriptions - most informative format.
 * Shows what each agent is actually doing.
 *
 * Format: O:analyzing code | e:searching files
 */
export function renderAgentsWithDescriptions(agents: ActiveAgent[]): string | null {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return null;
  }

  const now = Date.now();

  // Build agent entries with descriptions
  const entries = running.map((a) => {
    const code = getAgentCode(a.type, a.model);
    const color = getModelTierColor(a.model);
    const desc = truncateDescription(a.description, 25);
    const durationMs = now - a.startTime.getTime();
    const duration = formatDuration(durationMs);

    // Format: O:description or O:description(2m)
    let entry = `${color}${code}${RESET}:${dim(desc)}`;
    if (duration && duration !== '!') {
      entry += dim(duration);
    } else if (duration === '!') {
      const durationColor = getDurationColor(durationMs);
      entry += `${durationColor}!${RESET}`;
    }

    return entry;
  });

  return entries.join(dim(' | '));
}

/**
 * Render agents showing descriptions only (no codes).
 * Maximum clarity about what's running.
 *
 * Format: [analyzing code, searching files]
 */
export function renderAgentsDescOnly(agents: ActiveAgent[]): string | null {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return null;
  }

  const now = Date.now();

  // Build descriptions
  const descriptions = running.map((a) => {
    const color = getModelTierColor(a.model);
    const shortName = getShortAgentName(a.type);
    const desc = a.description ? truncateDescription(a.description, 20) : shortName;
    const durationMs = now - a.startTime.getTime();
    const duration = formatDuration(durationMs);

    if (duration === '!') {
      const durationColor = getDurationColor(durationMs);
      return `${color}${desc}${durationColor}!${RESET}`;
    } else if (duration) {
      return `${color}${desc}${dim(duration)}${RESET}`;
    }
    return `${color}${desc}${RESET}`;
  });

  return `[${descriptions.join(dim(', '))}]`;
}

/**
 * Format duration with padding for alignment.
 */
function formatDurationPadded(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);

  if (seconds < 10) {
    return '    '; // No duration for very short
  } else if (seconds < 60) {
    return `${seconds}s`.padStart(4);
  } else if (minutes < 10) {
    return `${minutes}m`.padStart(4);
  } else {
    return `${minutes}m`.padStart(4);
  }
}

/**
 * Multi-line render result type.
 */
export interface MultiLineRenderResult {
  headerPart: string | null;
  detailLines: string[];
}

/**
 * Render agents as multi-line display for maximum clarity.
 * Returns header addition + multiple detail lines.
 *
 * Format:
 * ├─ O architect     2m   analyzing architecture patterns...
 * ├─ e explore    45s  searching for test files
 * └─ s sj-junior  1m   implementing validation logic
 */
export function renderAgentsMultiLine(
  agents: ActiveAgent[],
  maxLines: number = 5
): MultiLineRenderResult {
  const running = sortByFreshest(agents.filter((a) => a.status === 'running'));

  if (running.length === 0) {
    return { headerPart: null, detailLines: [] };
  }

  // Header part shows count for awareness
  const headerPart = `agents:${CYAN}${running.length}${RESET}`;

  // Build detail lines
  const now = Date.now();
  const detailLines: string[] = [];
  const displayCount = Math.min(running.length, maxLines);

  running.slice(0, maxLines).forEach((a, index) => {
    const isLast = index === displayCount - 1 && running.length <= maxLines;
    const prefix = isLast ? '└─' : '├─';

    const code = getAgentCode(a.type, a.model);
    const color = getModelTierColor(a.model);
    const shortName = getShortAgentName(a.type).padEnd(12);

    const durationMs = now - a.startTime.getTime();
    const duration = formatDurationPadded(durationMs);
    const durationColor = getDurationColor(durationMs);

    const desc = a.description || '...';
    const truncatedDesc = desc.length > 45 ? desc.slice(0, 42) + '...' : desc;

    detailLines.push(
      `${dim(prefix)} ${color}${code}${RESET} ${dim(shortName)}${durationColor}${duration}${RESET}  ${truncatedDesc}`
    );
  });

  // Add overflow indicator if needed
  if (running.length > maxLines) {
    const remaining = running.length - maxLines;
    detailLines.push(`${dim(`└─ +${remaining} more agents...`)}`);
  }

  return { headerPart, detailLines };
}

/**
 * Render agents based on format configuration.
 */
export function renderAgentsByFormat(
  agents: ActiveAgent[],
  format: AgentsFormat
): string | null {
  switch (format) {
    case 'count':
      return renderAgents(agents);
    case 'codes':
      return renderAgentsCoded(agents);
    case 'codes-duration':
      return renderAgentsCodedWithDuration(agents);
    case 'detailed':
      return renderAgentsDetailed(agents);
    case 'descriptions':
      return renderAgentsWithDescriptions(agents);
    case 'tasks':
      return renderAgentsDescOnly(agents);
    case 'multiline':
      // For backward compatibility, return just the header part
      // The render.ts will handle the full multi-line output
      return renderAgentsMultiLine(agents).headerPart;
    default:
      return renderAgentsCoded(agents);
  }
}
