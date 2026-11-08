/**
 * OMC HUD - Hostname Element
 *
 * Renders the current machine's short hostname. Useful when running
 * `omc` via SSH across multiple machines — the hostname in the HUD
 * prevents accidentally running destructive commands on the wrong
 * host when terminal tab titles are hidden behind tmux/screen splits.
 */
import { hostname } from 'node:os';
import { cyan } from '../colors.js';
/**
 * Render the short hostname (FQDN stripped).
 *
 * @returns Cyan-colored "host:<name>" label, or null if the OS returns
 *          an empty hostname (e.g. misconfigured containers).
 */
export function renderHostname() {
    const full = hostname();
    if (!full)
        return null;
    const short = full.split('.')[0];
    if (!short)
        return null;
    return cyan(`host:${short}`);
}
//# sourceMappingURL=hostname.js.map