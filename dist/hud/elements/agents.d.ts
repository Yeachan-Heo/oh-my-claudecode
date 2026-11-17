/**
 * OMC HUD - Agents Element
 *
 * Renders active agent count display with multiple format options:
 * - count: agents:2
 * - codes: agents:Oes (type-coded with model tier casing)
 * - detailed: agents:[architect(2m),explore,exec]
 */
import type { ActiveAgent, AgentsFormat } from '../types.js';
/**
 * Render active agent count.
 * Returns null if no agents are running.
 *
 * Format: agents:2
 */
export declare function renderAgents(agents: ActiveAgent[]): string | null;
/**
 * Render agents with single-character type codes.
 * Uppercase = Opus tier, lowercase = Sonnet/Haiku.
 * Color-coded by model tier.
 *
 * Format: agents:Oes
 */
export declare function renderAgentsCoded(agents: ActiveAgent[]): string | null;
/**
 * Render agents with codes and duration indicators.
 * Shows how long each agent has been running.
 *
 * Format: agents:O(2m)es
 */
export declare function renderAgentsCodedWithDuration(agents: ActiveAgent[]): string | null;
/**
 * Render detailed agent list (for full mode).
 *
 * Format: agents:[architect(2m),explore,exec]
 */
export declare function renderAgentsDetailed(agents: ActiveAgent[]): string | null;
/**
 * Render agents with descriptions - most informative format.
 * Shows what each agent is actually doing.
 *
 * Format: O:analyzing code | e:searching files
 */
export declare function renderAgentsWithDescriptions(agents: ActiveAgent[]): string | null;
/**
 * Render agents showing descriptions only (no codes).
 * Maximum clarity about what's running.
 *
 * Format: [analyzing code, searching files]
 */
export declare function renderAgentsDescOnly(agents: ActiveAgent[]): string | null;
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
 * └─ x exec       1m   implementing validation logic
 */
export declare function renderAgentsMultiLine(agents: ActiveAgent[], maxLines?: number): MultiLineRenderResult;
/**
 * Render agents based on format configuration.
 */
export declare function renderAgentsByFormat(agents: ActiveAgent[], format: AgentsFormat): string | null;
//# sourceMappingURL=agents.d.ts.map