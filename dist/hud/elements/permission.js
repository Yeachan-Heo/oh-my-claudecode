/**
 * OMC HUD - Permission Status Element
 *
 * Renders heuristic-based permission pending indicator.
 */
import { dim, yellow } from '../colors.js';
/**
 * Render permission pending indicator.
 *
 * Format: APPROVE? edit:filename.ts
 */
export function renderPermission(pending) {
    if (!pending)
        return null;
    return `${yellow('APPROVE?')} ${dim(pending.toolName.toLowerCase())}:${pending.targetSummary}`;
}
//# sourceMappingURL=permission.js.map