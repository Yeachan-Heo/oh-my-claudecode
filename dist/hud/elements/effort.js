/**
 * OMC HUD - Effort Level Element
 *
 * Renders the Claude Code effort level reported in statusline stdin.
 */
import { bold, cyan, dim, magenta, yellow } from '../colors.js';
/**
 * Render effort level, colored cool to warm by intensity. Red is avoided because the HUD uses it for critical state.
 *
 * @returns "effort:<level>" label, or null when stdin has no effort level
 */
export function renderEffort(level) {
    if (!level)
        return null;
    const label = `effort:${level}`;
    switch (level) {
        case 'low':
            return dim(label);
        case 'high':
            return yellow(label);
        case 'xhigh':
            return magenta(label);
        case 'max':
            return bold(magenta(label));
        case 'medium':
        default:
            return cyan(label);
    }
}
//# sourceMappingURL=effort.js.map