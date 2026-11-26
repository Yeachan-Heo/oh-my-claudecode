/**
 * Provider reading of the panel quota wait: the HTTP access to the provider's quota endpoint, kept apart from the
 * planning and the state of the wait (panel-quota-wait.ts, which re-exports readProviderQuota).
 */
import { readFileSync } from 'node:fs';
import { parseQuotaLimits } from './panel-quota-limits.js';
const READ_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
/**
 * Real provider reading for the daemon: GET of OMC_PANEL_QUOTA_READ_URL with the key from OMC_PANEL_QUOTA_KEY_FILE.
 * Returns null (no wait) when the URL, the key file, the response, the HTTP status or the shape of its limits is
 * unusable (a limit field of the wrong type, see panel-quota-limits.ts). The key stays in the request header only;
 * errors are not logged here.
 */
export async function readProviderQuota(env = process.env) {
    const url = quotaUrl(env.OMC_PANEL_QUOTA_READ_URL);
    if (!url || !env.OMC_PANEL_QUOTA_KEY_FILE)
        return null;
    const key = readKey(env.OMC_PANEL_QUOTA_KEY_FILE);
    if (!key)
        return null;
    let response;
    try {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${key}`, 'Accept-Language': 'en-US,en' },
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
    }
    catch {
        return null;
    }
    if (!response.ok)
        return null;
    let body;
    try {
        body = await response.json();
    }
    catch {
        return null;
    }
    // The status flag, when the provider sends one, must be the boolean true; the text "false" is not a success either.
    const success = body?.success;
    if (success !== undefined && success !== true)
        return null;
    if (!parseQuotaLimits(body))
        return null;
    return { body };
}
function quotaUrl(text) {
    try {
        const url = new URL(String(text ?? ''));
        const loopback = LOOPBACK_HOSTS.includes(url.hostname);
        return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
    }
    catch {
        return null;
    }
}
function readKey(file) {
    try {
        const key = readFileSync(file, 'utf8').trim();
        return key === '' ? null : key;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=panel-quota-reading.js.map