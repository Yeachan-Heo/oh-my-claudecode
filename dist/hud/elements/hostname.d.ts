/**
 * OMC HUD - Hostname Element
 *
 * Renders the current machine's short hostname. Useful when running
 * `omc` via SSH across multiple machines — the hostname in the HUD
 * prevents accidentally running destructive commands on the wrong
 * host when terminal tab titles are hidden behind tmux/screen splits.
 */
/**
 * Render the short hostname (FQDN stripped).
 *
 * @returns Cyan-colored "host:<name>" label, or null if the OS returns
 *          an empty hostname (e.g. misconfigured containers).
 */
export declare function renderHostname(): string | null;
//# sourceMappingURL=hostname.d.ts.map