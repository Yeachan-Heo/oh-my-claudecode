import { contextCollector } from '../../features/context-injector/index.js';
import { getSisyphusConfig } from '../../features/auto-update.js';
import { BEADS_INSTRUCTIONS, BEADS_RUST_INSTRUCTIONS } from './constants.js';
import type { TaskTool, BeadsContextConfig } from './types.js';

export type { TaskTool, BeadsContextConfig } from './types.js';
export { BEADS_INSTRUCTIONS, BEADS_RUST_INSTRUCTIONS } from './constants.js';

/**
 * Instructions map for each task tool variant.
 */
const INSTRUCTIONS_MAP: Record<Exclude<TaskTool, 'builtin'>, string> = {
  'beads': BEADS_INSTRUCTIONS,
  'beads-rust': BEADS_RUST_INSTRUCTIONS,
};

/**
 * Get beads instructions for the given tool variant.
 */
export function getBeadsInstructions(tool: Exclude<TaskTool, 'builtin'>): string {
  const instructions = INSTRUCTIONS_MAP[tool];
  if (!instructions) {
    throw new Error(`Unknown task tool: ${tool}`);
  }
  return instructions;
}

/**
 * Read beads context config from omc-config.json.
 */
export function getBeadsContextConfig(): BeadsContextConfig {
  const config = getSisyphusConfig();
  return {
    taskTool: config.taskTool ?? 'builtin',
    injectInstructions: config.taskToolConfig?.injectInstructions ?? true,
    useMcp: config.taskToolConfig?.useMcp ?? false,
  };
}

/**
 * Register beads context for a session.
 * Called from setup hook on session init.
 */
export function registerBeadsContext(sessionId: string): boolean {
  const config = getBeadsContextConfig();

  if (config.taskTool === 'builtin' || !config.injectInstructions) {
    return false;
  }

  // Validate taskTool is a known value
  if (!['beads', 'beads-rust'].includes(config.taskTool)) {
    // Unknown tool value - don't inject wrong instructions
    return false;
  }

  const instructions = getBeadsInstructions(config.taskTool);

  contextCollector.register(sessionId, {
    id: 'beads-instructions',
    source: 'beads',
    content: instructions,
    priority: 'normal',
  });

  return true;
}

/**
 * Clear beads context for a session.
 */
export function clearBeadsContext(sessionId: string): void {
  contextCollector.removeEntry(sessionId, 'beads', 'beads-instructions');
}
