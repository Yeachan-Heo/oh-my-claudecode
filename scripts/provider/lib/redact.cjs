'use strict';
// Redaction of secrets in messages written by provider tools. Text that may come
// from outside (error messages, provider response bodies) passes through mask()
// before it reaches stdout, stderr or a log. Credential-looking values are
// replaced; labels such as "Bearer" or "sk-" stay so the message is still readable.
// Order matters: narrower patterns run before the generic long-token pattern.

const SECRET_PATTERNS = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1[REDACTED]'],
  [/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1[REDACTED]'],
  [/\b(AIza)[0-9A-Za-z_-]{30,}/g, '$1[REDACTED]'],
  [/((?:[?&;_]|^)token=)[^&\s"']{4,}/gi, '$1[REDACTED]'],
  [/("(?:api_key|authorization|x-api-key|token|access_token|bearer)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
  // Provider keys have the form <hex>.<chars>. The whole key is masked, so no
  // tail after the dot is left behind; the hex part must not sit inside a longer word.
  [/(?<![\w=-])[0-9a-f]{24,}\.[A-Za-z0-9_-]{8,}(?![\w.])/g, '[REDACTED]'],
  // Headers and credential parameters written inline (x-api-key:, api_key=, Authorization: with or without Bearer).
  [/\b((?:x-api-key|api-key|api_key|apikey|authorization)\s*[:=]\s*(?:Bearer\s+)?)[^\s"']+/gi, '$1[REDACTED]'],
  [/(?<![A-Za-z0-9_=-])[A-Za-z0-9_=-]{40,}(?![A-Za-z0-9_=-])/g, '[REDACTED]'],
];

function mask(text) {
  let s = String(text ?? '');
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  return s;
}

module.exports = { mask, SECRET_PATTERNS };
