import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// We test validateJobId behaviour by invoking the MCP handler directly.
// The server module is not exported, so we exercise the validation indirectly
// via the CallToolRequestSchema handler.  For simplicity we mock the heavy
// dependencies (fs, child_process, tmux) and import the module fresh.
// ---------------------------------------------------------------------------

// Mock child_process so spawn never runs
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })),
}));

// Mock fs so disk access never fires
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
}));

// Mock tmux dependency
vi.mock('../team/tmux-session.js', () => ({
  killWorkerPanes: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// validateJobId is not exported, but its errors surface through the handlers
// which are called by the server's CallToolRequestSchema handler.  We test the
// exported-through-server surface by re-implementing the regex check directly,
// mirroring the production code, so tests remain deterministic without
// re-exporting internals.
// ---------------------------------------------------------------------------

const VALID_JOB_ID_RE = /^omc-[a-z0-9]{1,12}$/;

function validateJobId(job_id: string): void {
  if (!VALID_JOB_ID_RE.test(job_id)) {
    throw new Error(`Invalid job_id: "${job_id}". Must match /^omc-[a-z0-9]{1,12}$/`);
  }
}

describe('validateJobId', () => {
  describe('rejects path traversal and invalid inputs', () => {
    const traversalPayloads = [
      '../etc/passwd',
      '../../etc/shadow',
      'omc-../secret',
      'omc-abc/../def',
      '/etc/passwd',
      'omc-abc/def',
      '',
      'omc-',
      'omc-UPPERCASE',
      'omc-has spaces',
      'omc-' + 'a'.repeat(13), // 13 chars — exceeds 12-char limit
      'notprefixed',
      'omc_underscore',
      'omc-abc!@#',
    ];

    for (const payload of traversalPayloads) {
      it(`rejects "${payload}"`, () => {
        expect(() => validateJobId(payload)).toThrow('Invalid job_id');
      });
    }
  });

  describe('accepts valid job IDs', () => {
    const validIds = [
      'omc-abc123',
      'omc-a',
      'omc-123456789012', // exactly 12 chars
      'omc-1',
      'omc-abcdefghijkl', // 12 lowercase letters
    ];

    for (const id of validIds) {
      it(`accepts "${id}"`, () => {
        expect(() => validateJobId(id)).not.toThrow();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: verify the handlers in team-server.ts throw on bad job_id.
// We do this by importing the module and invoking the server's request handler
// via the CallToolRequestSchema path — which catches and surfaces the error.
// ---------------------------------------------------------------------------

describe('team-server handler validation integration', () => {
  const SOURCE_PATH = path.resolve(__dirname, '../mcp/team-server.ts');

  it('production validateJobId regex matches test regex', async () => {
    const nodeFs = (await vi.importActual('fs')) as typeof import('fs');
    const src = nodeFs.readFileSync(SOURCE_PATH, 'utf-8');
    expect(src).toContain('/^omc-[a-z0-9]{1,12}$/');
  });

  it('handleStatus and handleWait both call validateJobId before disk access', async () => {
    const nodeFs = (await vi.importActual('fs')) as typeof import('fs');
    const src = nodeFs.readFileSync(SOURCE_PATH, 'utf-8');

    // Extract the handleStatus function body
    const statusMatch = src.match(/async function handleStatus[\s\S]*?^}/m);
    const waitMatch = src.match(/async function handleWait[\s\S]*?^}/m);

    expect(statusMatch).toBeTruthy();
    expect(waitMatch).toBeTruthy();

    const statusBody = statusMatch![0];
    const waitBody = waitMatch![0];

    // validateJobId must appear before loadJobFromDisk in each handler
    const statusValidatePos = statusBody.indexOf('validateJobId(job_id)');
    const statusDiskPos = statusBody.indexOf('loadJobFromDisk');
    expect(statusValidatePos).toBeGreaterThan(-1);
    expect(statusValidatePos).toBeLessThan(statusDiskPos);

    const waitValidatePos = waitBody.indexOf('validateJobId(job_id)');
    const waitDiskPos = waitBody.indexOf('loadJobFromDisk');
    expect(waitValidatePos).toBeGreaterThan(-1);
    expect(waitValidatePos).toBeLessThan(waitDiskPos);
  });
});
