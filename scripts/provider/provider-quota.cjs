#!/usr/bin/env node
// Reads the provider usage quota (5 h window and week) without starting a model.
// Usage: provider-quota [--json]. The key comes from the profile key source and is never printed.
// Test-only variables (loopback addresses only): OMC_PROVIDER_QUOTA_URL, and OMC_PROVIDER_BASE_URL with OMC_PROVIDER_API_KEY_FILE.
'use strict';
const { loadProfile } = require('./lib/profile.cjs');
const { readKey } = require('./lib/settings.cjs');
const { quotaUrl, readQuota } = require('./lib/quota.cjs');
const { mask } = require('./lib/redact.cjs');
const { EXIT } = require('./lib/vocab.cjs');

const fail = (code, text) => {
  console.error(`provider-quota: ${mask(text)}`);
  process.exit(code);
};

const env = process.env;
let profile;
try {
  profile = loadProfile(env).profile;
} catch (e) {
  fail(e.exit ?? EXIT.CONFIG, e.message);
}
if (!quotaUrl(profile, env)) fail(EXIT.CONFIG, 'no quota endpoint is configured (quota.adapter and quota.url in the profile)');
const key = readKey(profile, env);
if (key.error) fail(EXIT.MISSING, key.error);

(async () => {
  const read = await readQuota(profile, env, key.key);
  if (read.error) fail(EXIT.QUOTA_REFUSED, read.error);
  const data = read.data;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(data));
    return;
  }
  const windowName = (l) => (l.unit === 3 ? `${l.number} h window` : l.unit === 6 ? 'weekly' : l.unit === 5 ? 'monthly' : `unit ${l.unit} x${l.number}`);
  const resetAt = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'none');
  console.log(`Plan: ${data.data?.level ?? '?'}`);
  for (const l of data.data?.limits ?? []) {
    const used = l.currentValue != null ? `, ${l.currentValue} of ${l.usage ?? '?'}` : '';
    const left = l.remaining != null ? `, ${l.remaining} left` : '';
    console.log(`${windowName(l)} (${l.type}): ${l.percentage}% used${used}${left}, reset ${resetAt(l.nextResetTime)}`);
  }
})();
