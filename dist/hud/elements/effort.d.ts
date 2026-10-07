/**
 * OMC HUD - Effort Level Element
 *
 * Renders the Claude Code effort level reported in statusline stdin.
 */
/**
 * Render effort level, colored cool to warm by intensity. Red is avoided because the HUD uses it for critical state.
 *
 * @returns "effort:<level>" label, or null when stdin has no effort level
 */
export declare function renderEffort(level: string | null | undefined): string | null;
//# sourceMappingURL=effort.d.ts.map