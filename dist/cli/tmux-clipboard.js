import { tmuxExec, tmuxExecAsync } from './tmux-utils.js';
const UNIVERSAL_CLIPBOARD_FEATURE = '*:clipboard';
export function hasUniversalClipboardTerminalFeature(features) {
    return features
        .split(/\r?\n|,/)
        .map((feature) => feature.trim())
        .some((feature) => feature === UNIVERSAL_CLIPBOARD_FEATURE || feature.startsWith(`${UNIVERSAL_CLIPBOARD_FEATURE}:`));
}
export function configureTmuxClipboardForSession(sessionName, opts) {
    tmuxExec(['set-option', '-t', sessionName, 'set-clipboard', 'on'], opts);
    let terminalFeatures = '';
    try {
        terminalFeatures = String(tmuxExec(['show-options', '-t', sessionName, '-v', 'terminal-features'], opts) ?? '');
    }
    catch {
        terminalFeatures = '';
    }
    if (!hasUniversalClipboardTerminalFeature(terminalFeatures)) {
        tmuxExec(['set-option', '-at', sessionName, 'terminal-features', `,${UNIVERSAL_CLIPBOARD_FEATURE}`], opts);
    }
}
export function configureTmuxClipboardForCurrentSession(opts) {
    const sessionName = String(tmuxExec(['display-message', '-p', '#S'], opts) ?? '').trim();
    if (sessionName) {
        configureTmuxClipboardForSession(sessionName, opts);
    }
}
export async function configureTmuxClipboardForSessionAsync(sessionName, opts) {
    await tmuxExecAsync(['set-option', '-t', sessionName, 'set-clipboard', 'on'], opts);
    let terminalFeatures = '';
    try {
        const result = await tmuxExecAsync(['show-options', '-t', sessionName, '-v', 'terminal-features'], opts);
        terminalFeatures = String(result.stdout ?? '');
    }
    catch {
        terminalFeatures = '';
    }
    if (!hasUniversalClipboardTerminalFeature(terminalFeatures)) {
        await tmuxExecAsync(['set-option', '-at', sessionName, 'terminal-features', `,${UNIVERSAL_CLIPBOARD_FEATURE}`], opts);
    }
}
//# sourceMappingURL=tmux-clipboard.js.map