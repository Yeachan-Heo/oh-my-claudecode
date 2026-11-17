/**
 * OMC HUD - Update Hint Element
 *
 * Renders copy-pasteable one-liners for available OMC / Claude Code updates,
 * in the same detail-line style as the context limit warning.
 */
import { RESET } from '../colors.js';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
/**
 * Render update hint detail lines (one per product, empty when up to date).
 *
 * The OMC command follows the install channel recorded by the session-start
 * update check: marketplace installs cannot be updated through npm.
 */
export function renderUpdateHints(input) {
    const lines = [];
    if (input.omcUpdateAvailable) {
        const command = input.omcUpdateSource === 'marketplace'
            ? 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc'
            : 'npm i -g oh-my-claude-sisyphus@latest';
        lines.push(`${YELLOW}${BOLD}[!] omc ${input.omcUpdateAvailable} - paste: ! ${command}${RESET}`);
    }
    if (input.claudeCodeUpdateAvailable) {
        lines.push(`${YELLOW}${BOLD}[!] claude ${input.claudeCodeUpdateAvailable} - paste: ! claude update${RESET}`);
    }
    return lines;
}
//# sourceMappingURL=update-hint.js.map