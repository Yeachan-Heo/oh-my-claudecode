/**
 * Verify session-end.mjs forwarder fast-no-ops for non-factory sessions.
 *
 * The forwarder template (templates/hooks/session-end.mjs) is copied to
 * ~/.claude/hooks/session-end.mjs for EVERY omc-setup user. It must
 * efficiently skip spawning the bridge when no factory chain ledger exists —
 * non-factory sessions should not incur a 10s timeout or process spawn overhead.
 *
 * This test asserts the forwarder source has the fast no-op check before
 * any spawnSync call.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FORWARDER = join(REPO_ROOT, 'templates', 'hooks', 'session-end.mjs');

describe('session-end.mjs forwarder fast no-op (issue #4153)', () => {
  it('checks for factory chain ledger before spawning the bridge', () => {
    const source = readFileSync(FORWARDER, 'utf8');
    
    // Must have the hasFactoryChainLedger function
    expect(source).toContain('hasFactoryChainLedger');
    
    // Must call hasFactoryChainLedger before spawnSync
    const hasFactoryCheckIdx = source.indexOf('hasFactoryChainLedger');
    const spawnSyncIdx = source.indexOf('spawnSync');
    expect(hasFactoryCheckIdx).toBeGreaterThan(0);
    expect(spawnSyncIdx).toBeGreaterThan(hasFactoryCheckIdx);
    
    // The check must exit early if no ledger exists
    expect(source).toContain('if (!hasFactoryChainLedger(cwd))');
    expect(source).toContain('process.exit(0)');
  });

  it('extracts cwd from the stdin payload to locate the project root', () => {
    const source = readFileSync(FORWARDER, 'utf8');
    
    // Must parse JSON from stdin
    expect(source).toContain('JSON.parse');
    expect(source).toContain('stdin');
    
    // Must look for cwd in the payload
    expect(source).toContain('payload.cwd');
  });

  it('defines hasFactoryChainLedger to efficiently check for chain-*.json files', () => {
    const source = readFileSync(FORWARDER, 'utf8');
    
    const hasFactoryMatch = source.match(
      /function hasFactoryChainLedger[\s\S]*?^}/m
    );
    expect(hasFactoryMatch).toBeDefined();
    const hasFactoryFn = hasFactoryMatch![0];
    
    // Must check the factory directory
    expect(hasFactoryFn).toContain('.omc');
    expect(hasFactoryFn).toContain('factory');
    
    // Must look for chain-*.json files
    expect(hasFactoryFn).toContain('chain-');
    expect(hasFactoryFn).toContain('.json');
  });
});
