/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */
/** Whether the opt-in key-shape redaction is on: OMC_REDACT_KEY_SHAPES is exactly `1`. */
export declare function keyShapesEnabled(): boolean;
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
 * - With OMC_REDACT_KEY_SHAPES=1 (opt-in): key shapes and NAME=value assignments
 *   (see keyShapeRanges)
 *
 * Without the switch the regex rules run one after the other on the text, as they always did. With it, the
 * rules and the key-shape scan all look at the ORIGINAL text: a rule that has masked a part of it cannot
 * take the name, the quote or the separator of an assignment away from the scan (`ghp_PASSWORD=canary` is
 * an assignment whatever the `ghp_` rule does to its name). Every range they find is masked in one pass.
 */
export declare function redactTokens(input: string): string;
/**
 * The first `max` characters of `text` for a log line or an error message.
 *
 * With OMC_REDACT_KEY_SHAPES=1 the whole text is redacted before it is cut, so a key that starts shortly
 * before the cut cannot leave a fragment that is too short to be recognized. Without the switch the
 * text is cut first, and the caller's own redaction masks what is left, so the output does not change.
 *
 * `finish` is a transformation of the text that the caller applies before it logs it and that adds syntax the
 * scan would misread (escapes: `\"` becomes `\\"` and ends a quoted value). It runs on the redacted text,
 * before the cut, so the redaction always sees the text as it was before the transformation.
 */
export declare function redactedPrefix(text: string, max: number, finish?: (redacted: string) => string): string;
/**
 * The start of `text` for a log line: its first `max` characters (see redactedPrefix), followed by `...` when
 * there is more. `cut` is how many characters of `text` the caller really uses (for example what it types
 * into a pane); the rest is ignored. `finish` is the one of redactedPrefix.
 */
export declare function redactedPreview(text: string, max: number, cut?: number, finish?: (redacted: string) => string): string;
//# sourceMappingURL=redact.d.ts.map