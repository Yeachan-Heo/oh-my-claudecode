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
export declare function redactTokens(input: string): string;
//# sourceMappingURL=redact.d.ts.map