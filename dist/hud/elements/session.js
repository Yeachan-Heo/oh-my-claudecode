/**
 * OMC HUD - Session Health Element
 *
 * Renders session duration and health indicator.
 */
import { green, red, yellow } from '../colors.js';
/**
 * Render session health indicator.
 *
 * Format: session:45m or session:45m (healthy)
 */
export function renderSession(session) {
    if (!session)
        return null;
    const colorize = session.health === 'critical' ? red
        : session.health === 'warning' ? yellow
            : green;
    return `session:${colorize(`${session.durationMinutes}m`)}`;
}
//# sourceMappingURL=session.js.map