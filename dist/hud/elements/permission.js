/**
 * OMC HUD - Permission Status Element
 *
 * Renders heuristic-based permission pending indicator.
 */
import { RESET } from '../colors.js';
// Local color constants (following context.ts pattern)
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
/**
 * Render permission pending indicator.
 *
 * Format: APPROVE? edit:filename.ts
 */
export function renderPermission(pending) {
    if (!pending)
        return null;
    return `${YELLOW}APPROVE?${RESET} ${DIM}${pending.toolName.toLowerCase()}${RESET}:${pending.targetSummary}`;
}
//# sourceMappingURL=permission.js.map