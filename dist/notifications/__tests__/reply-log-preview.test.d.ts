/**
 * The daemon log shows the first 50 characters of an injected reply. The reply must be redacted before it is
 * cut, on both injection paths (Herdr and tmux), also when maxMessageLength cuts the reply first, and before
 * sanitizeReplyInput adds its escapes (they double every backslash, which ends a quoted value too early).
 */
export {};
//# sourceMappingURL=reply-log-preview.test.d.ts.map