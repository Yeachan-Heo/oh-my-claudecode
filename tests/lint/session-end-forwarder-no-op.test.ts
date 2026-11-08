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
    // The guard call site must precede the spawnSync call site (the import of
    // spawnSync at the top of the file is not a call and is ignored).
    const guardIdx = source.indexOf('if (!(await hasFactoryChainLedger(cwd)))');
    const spawnCallIdx = source.indexOf('spawnSync(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(spawnCallIdx).toBeGreaterThan(guardIdx);
    
    // The check must exit early if no ledger exists
    expect(source).toContain('if (!(await hasFactoryChainLedger(cwd)))');
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
      /async function hasFactoryChainLedger[\s\S]*?^}/m
    );
    expect(hasFactoryMatch).toBeDefined();
    const hasFactoryFn = hasFactoryMatch![0];
    
    // Must resolve the state root like the enqueuer (getOmcRoot / OMC_STATE_DIR),
    // never a raw <cwd>/.omc path (multirepo-paths gate).
    expect(hasFactoryFn).toContain('resolveOmcStateRoot');
    expect(hasFactoryFn).not.toContain("'.omc'");
    expect(hasFactoryFn).toContain('factory');
    
    // Must look for chain-*.json files
    expect(hasFactoryFn).toContain('chain-');
    expect(hasFactoryFn).toContain('.json');
  });
});
