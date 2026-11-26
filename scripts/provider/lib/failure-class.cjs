// Classifies a failed provider worker run into one of FAILURE_CLASSES.
// Mirrors src/hud/usage-api.ts parseZaiResponse for the quota windows; the decision order below is fixed.
const { FAILURE_CLASSES } = require('./vocab.cjs');

const SERVER_ERROR_CODES = [500, 502, 503, 504, 529];

// status: HTTP status of the failed call; providerCode: error code from the provider body;
// text: free text (API error message, transcript error field, worker output); quota: quota read result
// ({ data: { limits } } or a bare limits array); advisor: advisor status ('timeout' | 'error' | other).
function failureClass({ status, providerCode, text, quota, advisor } = {}, profile = {}) {
  // An advisor failure is not a provider failure or a worker failure.
  if (advisor === 'timeout' || advisor === 'error') return FAILURE_CLASSES.ADVISOR;

  const quotaCodes = profile.errorCodes?.quota ?? [];
  const throttleCodes = profile.errorCodes?.throttle ?? [];
  const exhausted = profile.quota?.exhaustedPercent ?? 100;
  const knownCodes = [...quotaCodes, ...throttleCodes];

  const textCode = typeof text === 'string'
    ? (/["']?code["']?\s*[:=]\s*["']?(\d{4})\b/i.exec(text)?.[1]
      ?? (knownCodes.length ? new RegExp(`\\b(${knownCodes.join('|')})\\b`).exec(text)?.[1] : undefined))
    : undefined;
  const code = Number(providerCode ?? textCode);

  // Quota codes: pause until the window resets, no retries.
  if (quotaCodes.includes(code)) return FAILURE_CLASSES.QUOTA;
  // A quota read after the failure that shows a window at or above the exhausted percentage.
  const windows = Array.isArray(quota?.data?.limits) ? quota.data.limits : Array.isArray(quota) ? quota : [];
  if (windows.some((limit) => Number(limit?.percentage) >= exhausted)) return FAILURE_CLASSES.QUOTA;
  // Billing errors from the transcript error field.
  if (typeof text === 'string' && /billing_error|credit balance is too low/i.test(text)) return FAILURE_CLASSES.QUOTA;

  if (Number(status) === 401 || Number(status) === 403
    || (typeof text === 'string' && /authentication_failed|invalid (api )?key|(?:API Error|HTTP)\s*:?\s*40[13]\b/i.test(text))) {
    return FAILURE_CLASSES.AUTH;
  }
  // Provider overload: throttle, not quota.
  if (throttleCodes.includes(code)) return FAILURE_CLASSES.THROTTLE;
  // A plain 429 from concurrency limits: retry, not pause.
  if (Number(status) === 429 || (typeof text === 'string' && /(?:API Error|HTTP)\s*:?\s*429\b/i.test(text))) {
    return FAILURE_CLASSES.THROTTLE;
  }
  if (SERVER_ERROR_CODES.includes(Number(status))
    || (typeof text === 'string' && new RegExp(`(?:API Error|HTTP)\\s*:?\\s*(?:${SERVER_ERROR_CODES.join('|')})\\b`, 'i').test(text))) {
    return FAILURE_CLASSES.INFRA;
  }
  return FAILURE_CLASSES.OTHER;
}

module.exports = { failureClass, SERVER_ERROR_CODES };
