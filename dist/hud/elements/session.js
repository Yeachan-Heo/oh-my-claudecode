/**
 * OMC HUD - Session Health Element
 *
 * Renders session duration and health indicator.
 */
import { RESET } from '../colors.js';
// Local color constants (following context.ts pattern)
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
/**
 * Render session health indicator.
 *
 * Format: session:45m or session:45m (healthy)
 */
export function renderSession(session) {
    if (!session)
        return null;
    const color = session.health === 'critical' ? RED
        : session.health === 'warning' ? YELLOW
            : GREEN;
    return `session:${color}${session.durationMinutes}m${RESET}`;
}
//# sourceMappingURL=session.js.map