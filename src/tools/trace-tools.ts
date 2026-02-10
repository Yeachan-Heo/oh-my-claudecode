/**
 * Trace Tools - MCP tools for viewing agent flow traces
 *
 * Provides trace_timeline and trace_summary tools for the /trace feature.
 * Reads session replay JSONL files and formats them for display.
 */

import { z } from 'zod';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  readReplayEvents,
  getReplaySummary,
  type ReplayEvent,
  type ReplaySummary,
} from '../hooks/subagent-tracker/session-replay.js';
import {
  validateWorkingDirectory,
} from '../lib/worktree-paths.js';
import { ToolDefinition } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

const REPLAY_PREFIX = 'agent-replay-';

/**
 * Find the latest session ID from replay files
 */
function findLatestSessionId(directory: string): string | null {
  const stateDir = join(directory, '.omc', 'state');
  try {
    const files = readdirSync(stateDir)
      .filter(f => f.startsWith(REPLAY_PREFIX) && f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        sessionId: f.slice(REPLAY_PREFIX.length, -'.jsonl'.length),
        mtime: statSync(join(stateDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Format event type for display
 */
function formatEventType(event: string): string {
  const map: Record<string, string> = {
    agent_start: 'AGENT',
    agent_stop: 'AGENT',
    tool_start: 'TOOL',
    tool_end: 'TOOL',
    file_touch: 'FILE',
    intervention: 'INTERVENE',
    error: 'ERROR',
    hook_fire: 'HOOK',
    hook_result: 'HOOK',
    keyword_detected: 'KEYWORD',
    skill_activated: 'SKILL',
    skill_invoked: 'SKILL',
    mode_change: 'MODE',
  };
  return (map[event] || event.toUpperCase()).padEnd(9);
}

/**
 * Format a single event into a timeline line
 */
function formatTimelineEvent(event: ReplayEvent): string {
  const time = `${event.t.toFixed(1)}s`.padStart(7);
  const type = formatEventType(event.event);
  let detail = '';

  switch (event.event) {
    case 'agent_start':
      detail = `[${event.agent}] ${event.agent_type || 'unknown'} started`;
      if (event.task) detail += ` "${event.task}"`;
      if (event.model) detail += ` (${event.model})`;
      break;
    case 'agent_stop':
      detail = `[${event.agent}] ${event.agent_type || 'unknown'} ${event.success ? 'completed' : 'FAILED'}`;
      if (event.duration_ms) detail += ` (${(event.duration_ms / 1000).toFixed(1)}s)`;
      break;
    case 'tool_start':
      detail = `[${event.agent}] ${event.tool} started`;
      break;
    case 'tool_end':
      detail = `[${event.agent}] ${event.tool}`;
      if (event.duration_ms) detail += ` (${event.duration_ms}ms)`;
      if (event.success === false) detail += ' FAILED';
      break;
    case 'file_touch':
      detail = `[${event.agent}] ${event.file}`;
      break;
    case 'intervention':
      detail = `[${event.agent}] ${event.reason}`;
      break;
    case 'error':
      detail = `[${event.agent}] ${event.reason || 'unknown error'}`;
      break;
    case 'hook_fire':
      detail = `${event.hook} fired (${event.hook_event})`;
      break;
    case 'hook_result':
      detail = `${event.hook} result`;
      if (event.duration_ms) detail += ` (${event.duration_ms}ms`;
      if (event.context_injected) detail += `, context: ${event.context_length || '?'}B`;
      if (event.duration_ms) detail += ')';
      break;
    case 'keyword_detected':
      detail = `"${event.keyword}" detected`;
      break;
    case 'skill_activated':
      detail = `${event.skill_name} activated (${event.skill_source})`;
      break;
    case 'skill_invoked':
      detail = `${event.skill_name} invoked (via Skill tool)`;
      break;
    case 'mode_change':
      detail = `${event.mode_from} -> ${event.mode_to}`;
      break;
    default:
      detail = JSON.stringify(event);
  }

  return `${time}  ${type} ${detail}`;
}

type FilterType = 'all' | 'hooks' | 'skills' | 'agents' | 'keywords' | 'tools' | 'modes';

/**
 * Filter events by category
 */
function filterEvents(events: ReplayEvent[], filter: FilterType): ReplayEvent[] {
  if (filter === 'all') return events;

  const filterMap: Record<FilterType, string[]> = {
    all: [],
    hooks: ['hook_fire', 'hook_result'],
    skills: ['skill_activated', 'skill_invoked'],
    agents: ['agent_start', 'agent_stop'],
    keywords: ['keyword_detected'],
    tools: ['tool_start', 'tool_end'],
    modes: ['mode_change'],
  };

  const allowed = filterMap[filter];
  if (!allowed) return events;
  return events.filter(e => allowed.includes(e.event));
}

// ============================================================================
// Execution Flow Builder
// ============================================================================

/**
 * Build a narrative execution flow from key events (skip tool_start/tool_end noise)
 */
function buildExecutionFlow(events: ReplayEvent[]): string[] {
  const flow: string[] = [];
  const KEY_EVENTS = new Set([
    'keyword_detected', 'skill_activated', 'skill_invoked',
    'mode_change', 'agent_start', 'agent_stop',
  ]);

  for (const event of events) {
    if (!KEY_EVENTS.has(event.event)) continue;

    switch (event.event) {
      case 'keyword_detected':
        flow.push(`Keyword "${event.keyword}" detected`);
        break;
      case 'skill_activated':
        flow.push(`${event.skill_name} skill activated (${event.skill_source})`);
        break;
      case 'skill_invoked':
        flow.push(`${event.skill_name} invoked (via Skill tool)`);
        break;
      case 'mode_change':
        flow.push(`Mode: ${event.mode_from} -> ${event.mode_to}`);
        break;
      case 'agent_start': {
        const type = event.agent_type || 'unknown';
        const model = event.model ? `, ${event.model}` : '';
        flow.push(`${type} agent spawned (${event.agent}${model})`);
        break;
      }
      case 'agent_stop': {
        const type = event.agent_type || 'unknown';
        const status = event.success ? 'completed' : 'FAILED';
        const dur = event.duration_ms ? ` ${(event.duration_ms / 1000).toFixed(1)}s` : '';
        flow.push(`${type} agent ${status} (${event.agent}${dur})`);
        break;
      }
    }
  }

  return flow;
}

// ============================================================================
// trace_timeline - Chronological event timeline
// ============================================================================

export const traceTimelineTool: ToolDefinition<{
  sessionId: z.ZodOptional<z.ZodString>;
  filter: z.ZodOptional<z.ZodEnum<['all', 'hooks', 'skills', 'agents', 'keywords', 'tools', 'modes']>>;
  last: z.ZodOptional<z.ZodNumber>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'trace_timeline',
  description: 'Show chronological agent flow trace timeline. Displays hooks, keywords, skills, agents, and tools in time order. Use filter to show specific event types.',
  schema: {
    sessionId: z.string().optional().describe('Session ID (auto-detects latest if omitted)'),
    filter: z.enum(['all', 'hooks', 'skills', 'agents', 'keywords', 'tools', 'modes']).optional().describe('Filter to show specific event types (default: all)'),
    last: z.number().optional().describe('Limit to last N events'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { sessionId: requestedSessionId, filter = 'all', last, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = requestedSessionId || findLatestSessionId(root);

      if (!sessionId) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Agent Flow Trace\n\nNo trace sessions found. Traces are recorded automatically during agent execution.'
          }]
        };
      }

      let events = readReplayEvents(root, sessionId);

      if (events.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `## Agent Flow Trace (session: ${sessionId})\n\nNo events recorded for this session.`
          }]
        };
      }

      // Apply filter
      events = filterEvents(events, filter as FilterType);

      // Apply last limit
      if (last && last > 0 && events.length > last) {
        events = events.slice(-last);
      }

      const duration = events.length > 0
        ? (events[events.length - 1].t - events[0].t).toFixed(1)
        : '0.0';

      const lines = [
        `## Agent Flow Trace (session: ${sessionId})`,
        `Duration: ${duration}s | Events: ${events.length}${filter !== 'all' ? ` | Filter: ${filter}` : ''}`,
        '',
      ];

      for (const event of events) {
        lines.push(formatTimelineEvent(event));
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading trace: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

// ============================================================================
// trace_summary - Aggregate statistics
// ============================================================================

export const traceSummaryTool: ToolDefinition<{
  sessionId: z.ZodOptional<z.ZodString>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'trace_summary',
  description: 'Show aggregate statistics for an agent flow trace session. Includes hook stats, keyword frequencies, skill activations, mode transitions, and tool bottlenecks.',
  schema: {
    sessionId: z.string().optional().describe('Session ID (auto-detects latest if omitted)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    const { sessionId: requestedSessionId, workingDirectory } = args;

    try {
      const root = validateWorkingDirectory(workingDirectory);
      const sessionId = requestedSessionId || findLatestSessionId(root);

      if (!sessionId) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Trace Summary\n\nNo trace sessions found.'
          }]
        };
      }

      const summary = getReplaySummary(root, sessionId);

      if (summary.total_events === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `## Trace Summary (session: ${sessionId})\n\nNo events recorded.`
          }]
        };
      }

      const lines = [
        `## Trace Summary (session: ${sessionId})`,
        '',
        `### Overview`,
        `- **Duration:** ${summary.duration_seconds.toFixed(1)}s`,
        `- **Total Events:** ${summary.total_events}`,
        `- **Agents:** ${summary.agents_spawned} spawned, ${summary.agents_completed} completed, ${summary.agents_failed} failed`,
        '',
      ];

      // Agent Activity breakdown
      if (summary.agent_breakdown && summary.agent_breakdown.length > 0) {
        lines.push(`### Agent Activity`);
        lines.push('| Agent | Invocations | Total Time | Model | Avg Duration |');
        lines.push('|-------|-------------|------------|-------|--------------|');
        for (const ab of summary.agent_breakdown) {
          const totalSec = ab.total_ms > 0 ? `${(ab.total_ms / 1000).toFixed(1)}s` : '-';
          const avgSec = ab.avg_ms > 0 ? `${(ab.avg_ms / 1000).toFixed(1)}s` : '-';
          const models = ab.models.length > 0 ? ab.models.join(', ') : '-';
          lines.push(`| ${ab.type} | ${ab.count} | ${totalSec} | ${models} | ${avgSec} |`);
        }
        if (summary.cycle_count && summary.cycle_pattern) {
          lines.push(`> ${summary.cycle_count} ${summary.cycle_pattern} cycle(s) detected`);
        }
        lines.push('');
      }

      // Skills Invoked (via Skill tool)
      if (summary.skills_invoked && summary.skills_invoked.length > 0) {
        lines.push(`### Skills Invoked`);
        for (const skill of summary.skills_invoked) {
          lines.push(`- ${skill}`);
        }
        lines.push('');
      }

      // Skills Activated (via keyword/learned)
      if (summary.skills_activated && summary.skills_activated.length > 0) {
        lines.push(`### Skills Activated`);
        for (const skill of summary.skills_activated) {
          lines.push(`- ${skill}`);
        }
        lines.push('');
      }

      // Hook stats
      if (summary.hooks_fired) {
        lines.push(`### Hooks`);
        lines.push(`- **Hooks fired:** ${summary.hooks_fired}`);
        lines.push('');
      }

      // Keywords
      if (summary.keywords_detected && summary.keywords_detected.length > 0) {
        lines.push(`### Keywords Detected`);
        for (const kw of summary.keywords_detected) {
          lines.push(`- ${kw}`);
        }
        lines.push('');
      }

      // Mode transitions
      if (summary.mode_transitions && summary.mode_transitions.length > 0) {
        lines.push(`### Mode Transitions`);
        for (const t of summary.mode_transitions) {
          lines.push(`- ${t.from} -> ${t.to} (at ${t.at.toFixed(1)}s)`);
        }
        lines.push('');
      }

      // Execution Flow (chronological narrative from events)
      const flowEvents = buildExecutionFlow(readReplayEvents(root, sessionId));
      if (flowEvents.length > 0) {
        lines.push(`### Execution Flow`);
        for (let i = 0; i < flowEvents.length; i++) {
          lines.push(`${i + 1}. ${flowEvents[i]}`);
        }
        lines.push('');
      }

      // Tool summary
      const toolEntries = Object.entries(summary.tool_summary);
      if (toolEntries.length > 0) {
        lines.push(`### Tool Performance`);
        lines.push('| Tool | Calls | Avg (ms) | Max (ms) | Total (ms) |');
        lines.push('|------|-------|----------|----------|------------|');
        for (const [tool, stats] of toolEntries.sort((a, b) => b[1].total_ms - a[1].total_ms)) {
          lines.push(`| ${tool} | ${stats.count} | ${stats.avg_ms} | ${stats.max_ms} | ${stats.total_ms} |`);
        }
        lines.push('');
      }

      // Bottlenecks
      if (summary.bottlenecks.length > 0) {
        lines.push(`### Bottlenecks (>1s avg)`);
        for (const b of summary.bottlenecks) {
          lines.push(`- **${b.tool}** by agent \`${b.agent}\`: avg ${b.avg_ms}ms`);
        }
        lines.push('');
      }

      // Files touched
      if (summary.files_touched.length > 0) {
        lines.push(`### Files Touched (${summary.files_touched.length})`);
        for (const f of summary.files_touched.slice(0, 20)) {
          lines.push(`- ${f}`);
        }
        if (summary.files_touched.length > 20) {
          lines.push(`- ... and ${summary.files_touched.length - 20} more`);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error generating summary: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
};

/**
 * All trace tools for registration
 */
export const traceTools = [traceTimelineTool, traceSummaryTool];
