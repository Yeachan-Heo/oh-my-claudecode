import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The OhMy fork removed the upstream update poller from both session-start
// hooks. (Previously "BUG 4" guarded that poller's AbortController timeout was
// cleared in a `finally` block; with the poller gone, these tests guard that it
// stays removed so the fork never silently reintroduces upstream version polling.)
describe('OhMy fork: session-start hooks do not poll npm for updates', () => {
  it('scripts/session-start.mjs has no npm update poller', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/session-start.mjs'), 'utf-8');
    expect(source).not.toContain('registry.npmjs.org');
    expect(source).not.toMatch(/async function checkNpmUpdate/);
  });

  it('templates/hooks/session-start.mjs has no npm update poller', () => {
    const source = readFileSync(join(process.cwd(), 'templates/hooks/session-start.mjs'), 'utf-8');
    expect(source).not.toContain('registry.npmjs.org');
    expect(source).not.toMatch(/async function checkForUpdates/);
  });
});
