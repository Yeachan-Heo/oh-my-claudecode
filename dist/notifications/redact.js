/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */
/**
 * Redact sensitive tokens from a string.
 *
 * Patterns masked:
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace tokens: xoxp-..., xoxa-...
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 */
export function redactTokens(input) {
    return input
        // Slack tokens: xoxb-..., xapp-..., xoxp-..., xoxa-...
        .replace(/\b(xox[bpae]-)[A-Za-z0-9-]+/g, '$1****')
        .replace(/\b(xapp-)[A-Za-z0-9-]+/g, '$1****')
        // Telegram bot tokens in URL paths: /bot123456:ABC.../
        .replace(/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****')
        // Telegram bot tokens standalone: 123456789:AAHfoo-bar_Baz
        .replace(/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****')
        // Bearer/Bot authorization values in error strings
        .replace(/(Bearer\s+)\S+/gi, '$1****')
        .replace(/(Bot\s+)\S+/gi, '$1****')
        // Anthropic API keys: sk-ant-api...
        .replace(/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****')
        // GitHub tokens: ghp_, gho_, ghs_, github_pat_
        .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
        // AWS access key IDs: AKIA...
        .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****');
}
//# sourceMappingURL=redact.js.map