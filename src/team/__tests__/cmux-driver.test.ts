import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process before importing the driver
// ---------------------------------------------------------------------------

const mockCalls = vi.hoisted(() => ({
  calls: [] as Array<{ bin: string; args: string[] }>,
  responses: new Map<string, { stdout: string; stderr: string }>(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const resolve = (args: string[]): { stdout: string; stderr: string } => {
    // Match by first non-flag argument (the cmux subcommand)
    const subcommand = args.find(a => !a.startsWith('-')) ?? '';
    const key = args.includes('--json') ? `json:${subcommand}` : subcommand;
    return mockCalls.responses.get(key) ?? { stdout: '', stderr: '' };
  };

  const execFileMock = vi.fn(
    (bin: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      mockCalls.calls.push({ bin, args });
      const { stdout, stderr } = resolve(args);
      cb(null, stdout, stderr);
      return {} as never;
    },
  );

  // Support promisify
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  (execFileMock as unknown as Record<symbol, unknown>)[promisifyCustom] =
    async (bin: string, args: string[]) => {
      mockCalls.calls.push({ bin, args });
      return resolve(args);
    };

  const execFileSyncMock = vi.fn((bin: string, args: string[]) => {
    mockCalls.calls.push({ bin, args });
    const { stdout } = resolve(args);
    return stdout;
  });

  return { ...actual, execFile: execFileMock, execFileSync: execFileSyncMock };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path === '/Applications/cmux.app/Contents/Resources/bin/cmux') return true;
      return actual.existsSync(path);
    }),
  };
});

import {
  detectCmux,
  resolveLayout,
  resolveLeader,
  spawnWorker,
  sendCommand,
  captureSurface,
  focusLeader,
  sessionName as cmuxSessionName,
  CmuxUnsupportedError,
  CmuxCliNotFoundError,
  _resetCmuxBinaryCache,
} from '../multiplexer/cmux-driver.js';

// ---------------------------------------------------------------------------
// Fixtures: recorded JSON from cmux 0.61.0
// ---------------------------------------------------------------------------

const IDENTIFY_JSON = JSON.stringify({
  caller: {
    workspace_ref: 'workspace:1',
    pane_ref: 'pane:1',
    surface_ref: 'surface:1',
    tab_ref: 'tab:1',
    window_ref: 'window:1',
    surface_type: 'terminal',
    is_browser_surface: false,
  },
  focused: {
    workspace_ref: 'workspace:1',
    pane_ref: 'pane:1',
    surface_ref: 'surface:1',
    tab_ref: 'tab:1',
    window_ref: 'window:1',
    surface_type: 'terminal',
    is_browser_surface: false,
  },
  socket_path: '/tmp/cmux.sock',
});

const NEW_SURFACE_JSON = JSON.stringify({
  surface_ref: 'surface:2',
  pane_ref: 'pane:1',
  workspace_ref: 'workspace:1',
});

const NEW_SPLIT_JSON = JSON.stringify({
  surface_ref: 'surface:3',
  pane_ref: 'pane:2',
  workspace_ref: 'workspace:1',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupStandardMocks(): void {
  mockCalls.responses.set('version', { stdout: 'cmux 0.61.0 (73) [8caa5e9c9]\n', stderr: '' });
  mockCalls.responses.set('json:identify', { stdout: IDENTIFY_JSON, stderr: '' });
  mockCalls.responses.set('json:new-surface', { stdout: NEW_SURFACE_JSON, stderr: '' });
  mockCalls.responses.set('json:new-split', { stdout: NEW_SPLIT_JSON, stderr: '' });
  mockCalls.responses.set('json:capabilities', { stdout: '{"version":2,"methods":[]}', stderr: '' });
  mockCalls.responses.set('rename-tab', { stdout: '', stderr: '' });
  mockCalls.responses.set('send', { stdout: '', stderr: '' });
  mockCalls.responses.set('send-key', { stdout: '', stderr: '' });
  mockCalls.responses.set('capture-pane', { stdout: '$ some output\n❯ \n', stderr: '' });
  mockCalls.responses.set('tab-action', { stdout: '', stderr: '' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cmux-driver', () => {
  beforeEach(() => {
    mockCalls.calls = [];
    mockCalls.responses.clear();
    _resetCmuxBinaryCache();
    setupStandardMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('resolveLayout', () => {
    it('defaults to tab when unset', () => {
      expect(resolveLayout(undefined)).toBe('tab');
      expect(resolveLayout('')).toBe('tab');
    });

    it('accepts canonical values', () => {
      expect(resolveLayout('tab')).toBe('tab');
      expect(resolveLayout('split-right')).toBe('split-right');
      expect(resolveLayout('split-down')).toBe('split-down');
      expect(resolveLayout('split-left')).toBe('split-left');
      expect(resolveLayout('split-up')).toBe('split-up');
    });

    it('accepts short aliases', () => {
      expect(resolveLayout('right')).toBe('split-right');
      expect(resolveLayout('down')).toBe('split-down');
      expect(resolveLayout('tabs')).toBe('tab');
    });

    it('defaults to tab for unknown values with a warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveLayout('potato')).toBe('tab');
      expect(warnSpy).toHaveBeenCalledOnce();
      warnSpy.mockRestore();
    });
  });

  describe('detectCmux', () => {
    it('succeeds with cmux >= 0.61.0', async () => {
      await expect(detectCmux()).resolves.toBeUndefined();
    });

    it('throws CmuxUnsupportedError for old cmux', async () => {
      mockCalls.responses.set('version', { stdout: 'cmux 0.50.0 (1) [abc]\n', stderr: '' });
      await expect(detectCmux()).rejects.toThrow(CmuxUnsupportedError);
      await expect(detectCmux()).rejects.toThrow(/0\.61\.0/);
    });

    it('throws CmuxUnsupportedError for unparseable version', async () => {
      mockCalls.responses.set('version', { stdout: 'unknown\n', stderr: '' });
      await expect(detectCmux()).rejects.toThrow(CmuxUnsupportedError);
    });
  });

  describe('resolveLeader', () => {
    it('returns leader handle with identity from cmux identify', async () => {
      vi.stubEnv('OMC_CMUX_LAYOUT', '');
      const leader = await resolveLeader();
      expect(leader.kind).toBe('cmux');
      expect(leader.identity.workspaceRef).toBe('workspace:1');
      expect(leader.identity.paneRef).toBe('pane:1');
      expect(leader.identity.surfaceRef).toBe('surface:1');
      expect(leader.layout).toBe('tab');
    });

    it('respects OMC_CMUX_LAYOUT env var', async () => {
      vi.stubEnv('OMC_CMUX_LAYOUT', 'split-down');
      const leader = await resolveLeader();
      expect(leader.layout).toBe('split-down');
    });
  });

  describe('spawnWorker (tab mode)', () => {
    it('creates a new surface and renames the tab', async () => {
      vi.stubEnv('OMC_CMUX_LAYOUT', '');
      const leader = await resolveLeader();
      const worker = await spawnWorker(leader, 'myteam/worker-1');

      expect(worker.kind).toBe('cmux');
      expect(worker.surfaceRef).toBe('surface:2');

      // Verify command sequence: new-surface, then rename-tab
      const cmuxCalls = mockCalls.calls.filter(c =>
        c.args.some(a => a === 'new-surface' || a === 'rename-tab'),
      );
      expect(cmuxCalls.length).toBeGreaterThanOrEqual(2);

      const newSurfaceCall = cmuxCalls.find(c => c.args.includes('new-surface'));
      expect(newSurfaceCall?.args).toContain('--pane');
      expect(newSurfaceCall?.args).toContain('pane:1');

      const renameCall = cmuxCalls.find(c => c.args.includes('rename-tab'));
      expect(renameCall?.args).toContain('myteam/worker-1');
    });
  });

  describe('spawnWorker (split mode)', () => {
    it('uses new-split with the right direction', async () => {
      vi.stubEnv('OMC_CMUX_LAYOUT', 'split-right');
      const leader = await resolveLeader();
      const worker = await spawnWorker(leader, 'myteam/worker-1');

      expect(worker.surfaceRef).toBe('surface:3');

      const splitCall = mockCalls.calls.find(c => c.args.includes('new-split'));
      expect(splitCall?.args).toContain('right');
      expect(splitCall?.args).toContain('--surface');
      expect(splitCall?.args).toContain('surface:1');
    });
  });

  describe('sendCommand', () => {
    it('calls cmux send followed by send-key Return', async () => {
      const worker = { kind: 'cmux' as const, surfaceRef: 'surface:2', label: 'w1' };
      await sendCommand(worker, 'echo hello');

      const sendCall = mockCalls.calls.find(c => c.args.includes('send'));
      expect(sendCall?.args).toContain('--surface');
      expect(sendCall?.args).toContain('surface:2');
      expect(sendCall?.args).toContain('echo hello');

      const keyCall = mockCalls.calls.find(c => c.args.includes('send-key'));
      expect(keyCall?.args).toContain('Return');
    });
  });

  describe('captureSurface', () => {
    it('returns captured pane output', async () => {
      const content = await captureSurface('surface:1', 80);
      expect(content).toContain('some output');

      const captureCall = mockCalls.calls.find(c => c.args.includes('capture-pane'));
      expect(captureCall?.args).toContain('--surface');
      expect(captureCall?.args).toContain('--lines');
      expect(captureCall?.args).toContain('80');
    });
  });

  describe('focusLeader', () => {
    it('calls tab-action select', async () => {
      const leader = await resolveLeader();
      await focusLeader(leader);

      const focusCall = mockCalls.calls.find(c => c.args.includes('tab-action'));
      expect(focusCall?.args).toContain('select');
      expect(focusCall?.args).toContain('surface:1');
    });
  });

  describe('cmuxSessionName', () => {
    it('returns a cmux: prefixed session name', async () => {
      const leader = await resolveLeader();
      expect(cmuxSessionName(leader)).toBe('cmux:workspace:1');
    });
  });
});
