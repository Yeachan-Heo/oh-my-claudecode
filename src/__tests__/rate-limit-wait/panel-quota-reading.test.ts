/**
 * Tests for the provider reading of the opt-in worker panel quota wait (panel-quota-reading.ts): a GET of
 * OMC_PANEL_QUOTA_READ_URL against a loopback HTTP stub, with the key from a temporary key file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { readProviderQuota } from '../../features/rate-limit-wait/panel-quota-reading.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function stub(status: number, body: string): Promise<{ url: string; auth: () => string | undefined }> {
  let auth: string | undefined;
  const server: Server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  // On every IPv4 address, so 127.0.0.2 (loopback, but not a listed loopback host) reaches it too.
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/quota`, auth: () => auth };
}

function keyFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-quota-key-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'key');
  writeFileSync(file, text);
  return file;
}

const LIMITS = { success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: 1 }] } };

describe('panel quota wait: provider reading', () => {
  it('returns the body of a 200 reading and sends the trimmed key as a bearer token', async () => {
    const s = await stub(200, JSON.stringify(LIMITS));
    const reading = await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('  k-123\n') });
    expect(reading).toEqual({ body: LIMITS });
    expect(s.auth()).toBe('Bearer k-123');
  });

  it('a non-2xx status is no reading, even when its body looks like limits', async () => {
    const s = await stub(500, JSON.stringify(LIMITS));
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
  });

  it('a body with success false is no reading, even with limits in it', async () => {
    const s = await stub(200, JSON.stringify({ ...LIMITS, success: false }));
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
  });

  it('no URL, no key file, an empty key, or plain http to a host outside the loopback list: no reading from a good stub', async () => {
    const s = await stub(200, JSON.stringify(LIMITS));
    const key = keyFile('k');
    // The stub answers a good reading, so each null below comes from the guard named in the case.
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: key })).toEqual({ body: LIMITS });
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_KEY_FILE: key })).toBeNull();
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url })).toBeNull();
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('  \n') })).toBeNull();
    expect(s.auth()).toBe('Bearer k');
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url.replace('127.0.0.1', '127.0.0.2'), OMC_PANEL_QUOTA_KEY_FILE: key })).toBeNull();
  });

  it('a body that is not JSON is no reading', async () => {
    const s = await stub(200, 'not json');
    expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
  });
});
