import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockRunWithClientLease, mockGetServerForFile } = vi.hoisted(() => ({
  mockRunWithClientLease: vi.fn(),
  mockGetServerForFile: vi.fn(),
}));

vi.mock('../../lsp/index.js', () => ({
  lspClientManager: {
    runWithClientLease: mockRunWithClientLease,
  },
  getServerForFile: mockGetServerForFile,
}));

import { runLspAggregatedDiagnostics } from '../lsp-aggregator.js';
import { formatLspResult } from '../index.js';
import type { LspAggregationResult } from '../lsp-aggregator.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runLspAggregatedDiagnostics', () => {
  it('bounds concurrent files while processing more than one at a time', async () => {
    mockGetServerForFile.mockReturnValue({
      command: 'test-lsp',
      installHint: 'install test-lsp',
    });

    let active = 0;
    let maxActive = 0;
    mockRunWithClientLease.mockImplementation(async (_file, callback) => {
      const openDocument = vi.fn();
      const closeDocument = vi.fn().mockResolvedValue(undefined);
      return callback({
        supportsPullDiagnostics: false,
        openDocument,
        closeDocument,
        withOpenDocument: async (file: string, operation: () => Promise<unknown>) => {
          await openDocument(file);
          try {
            return await operation();
          } finally {
            await closeDocument(file);
          }
        },
        waitForDiagnostics: vi.fn(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active--;
        }),
        getDiagnostics: vi.fn(() => []),
      });
    });

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      for (let index = 0; index < 12; index++) {
        writeFileSync(join(tmp, `${index.toString().padStart(2, '0')}.ts`), '');
      }

      const startedAt = performance.now();
      const result = await runLspAggregatedDiagnostics(tmp);
      const elapsedMs = performance.now() - startedAt;
      console.info(JSON.stringify({ files: 12, delayPerFileMs: 25, elapsedMs, maxActive }));
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(8);
      expect(result.filesChecked).toBe(12);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('closes every document it opens, including when diagnostics waiting fails', async () => {
    mockGetServerForFile.mockReturnValue({
      command: 'test-lsp',
      installHint: 'install test-lsp',
    });
    const openDocument = vi.fn();
    const closeDocument = vi.fn().mockResolvedValue(undefined);
    const waitForDiagnostics = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cancelled'));
    mockRunWithClientLease.mockImplementation(async (_file, callback) =>
      callback({
        supportsPullDiagnostics: false,
        openDocument,
        closeDocument,
        withOpenDocument: async (file: string, operation: () => Promise<unknown>) => {
          await openDocument(file);
          try {
            return await operation();
          } finally {
            await closeDocument(file);
          }
        },
        waitForDiagnostics,
        getDiagnostics: vi.fn(() => []),
      })
    );

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.ts'), '');
      writeFileSync(join(tmp, 'b.ts'), '');

      const result = await runLspAggregatedDiagnostics(tmp);

      console.info(JSON.stringify({ opened: openDocument.mock.calls.length, closed: closeDocument.mock.calls.length }));
      expect(openDocument).toHaveBeenCalledTimes(2);
      expect(closeDocument).toHaveBeenCalledTimes(2);
      expect(closeDocument.mock.calls).toEqual(openDocument.mock.calls);
      expect(result.filesChecked).toBe(1);
      expect(result.skippedFiles).toHaveLength(1);
      expect(result.skippedFiles[0].reason).toBe('cancelled');
      expect(result.success).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('uses pull diagnostics when the server advertises support', async () => {
    mockGetServerForFile.mockReturnValue({ command: 'test-lsp', installHint: 'install test-lsp' });
    const pullDiagnostics = vi.fn().mockResolvedValue([{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: 'pulled diagnostic',
      severity: 1,
    }]);
    const waitForDiagnostics = vi.fn();
    mockRunWithClientLease.mockImplementation(async (_file, callback) => callback({
      supportsPullDiagnostics: true,
      withOpenDocument: async (_file: string, operation: () => Promise<unknown>) => operation(),
      pullDiagnostics,
      waitForDiagnostics,
      getDiagnostics: vi.fn(() => []),
    }));

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.ts'), '');

      const result = await runLspAggregatedDiagnostics(tmp);

      expect(pullDiagnostics).toHaveBeenCalledOnce();
      expect(waitForDiagnostics).not.toHaveBeenCalled();
      expect(result.diagnostics.map(item => item.diagnostic.message)).toEqual(['pulled diagnostic']);
      expect(result.success).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('preserves file order without losing or duplicating diagnostics', async () => {
    mockGetServerForFile.mockReturnValue({ command: 'test-lsp', installHint: 'install test-lsp' });
    mockRunWithClientLease.mockImplementation(async (file, callback) => callback({
      supportsPullDiagnostics: false,
      withOpenDocument: async (_file: string, operation: () => Promise<unknown>) => operation(),
      waitForDiagnostics: vi.fn(async () => {
        const delay = file.endsWith('a.ts') ? 20 : file.endsWith('b.ts') ? 10 : 0;
        await new Promise(resolve => setTimeout(resolve, delay));
      }),
      getDiagnostics: vi.fn(() => [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: file.slice(-4),
        severity: 1,
      }]),
    }));

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.ts'), '');
      writeFileSync(join(tmp, 'b.ts'), '');
      writeFileSync(join(tmp, 'c.ts'), '');

      const result = await runLspAggregatedDiagnostics(tmp);

      expect(result.diagnostics.map(item => item.diagnostic.message)).toEqual(['a.ts', 'b.ts', 'c.ts']);
      expect(new Set(result.diagnostics.map(item => item.file)).size).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('surfaces install hints when language server is missing', async () => {
    mockGetServerForFile.mockReturnValue({
      command: 'ty',
      installHint: 'Install ty from https://github.com/astral-sh/ty',
    });
    mockRunWithClientLease.mockRejectedValue(
      new Error("Language server 'ty' not found.\nInstall with: Install ty from https://github.com/astral-sh/ty")
    );

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.py'), '');
      writeFileSync(join(tmp, 'b.py'), '');

      const result = await runLspAggregatedDiagnostics(tmp, ['.py']);

      expect(result.installHints).toEqual(['Install ty from https://github.com/astral-sh/ty']);
      expect(result.skippedFiles.length).toBe(2);
      expect(result.skippedFiles[0].reason).toMatch(/missing language server: ty/);
      expect(result.filesChecked).toBe(0);
      expect(result.success).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('surfaces the selected basedpyright install hint without ty fallback', async () => {
    mockGetServerForFile.mockReturnValue({
      command: 'basedpyright-langserver',
      installHint: 'uv tool install basedpyright',
    });
    mockRunWithClientLease.mockRejectedValue(
      new Error("Language server 'basedpyright-langserver' not found.\nInstall with: uv tool install basedpyright")
    );

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.py'), '');

      const result = await runLspAggregatedDiagnostics(tmp, ['.py']);

      expect(result.installHints).toEqual(['uv tool install basedpyright']);
      expect(result.skippedFiles[0].reason).toBe('missing language server: basedpyright-langserver');
      expect(result.skippedFiles[0].reason).not.toBe('missing language server: ty');
      expect(result.success).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('pre-check skips files with no registered language server', async () => {
    mockGetServerForFile.mockReturnValueOnce(null).mockReturnValue({ command: 'ty', installHint: 'pip install ty' });
    mockRunWithClientLease.mockImplementation(async (_file, callback) =>
      callback({
        supportsPullDiagnostics: false,
        withOpenDocument: async (_file: string, operation: () => Promise<unknown>) => operation(),
        waitForDiagnostics: vi.fn(),
        getDiagnostics: vi.fn(() => []),
      })
    );

    const tmp = mkdtempSync(join(tmpdir(), 'lsp-agg-test-'));
    try {
      writeFileSync(join(tmp, 'a.py'), '');
      writeFileSync(join(tmp, 'b.py'), '');

      const result = await runLspAggregatedDiagnostics(tmp, ['.py']);

      expect(result.skippedFiles.length).toBe(1);
      expect(result.skippedFiles[0].reason).toBe('no language server registered for extension');
      expect(mockRunWithClientLease).toHaveBeenCalledTimes(1);
      expect(result.installHints).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe('formatLspResult', () => {
  it('renders install hint header and incomplete summary', () => {
    const input: LspAggregationResult = {
      installHints: ['pip install ty'],
      skippedFiles: [{ file: 'a.py', reason: 'missing language server: ty' }],
      filesChecked: 0,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      success: false,
    };

    const out = formatLspResult(input);

    expect(out.diagnostics).toContain('⚠ Missing language servers detected:');
    expect(out.diagnostics).toContain('pip install ty');
    expect(out.summary).toContain('LSP check incomplete');
    expect(out.summary).toContain('(0/1 files checked)');
    expect(out.success).toBe(false);
    expect(out.strategy).toBe('lsp');
  });

  it('happy path output is byte-identical to pre-change behavior', () => {
    const input: LspAggregationResult = {
      installHints: [],
      skippedFiles: [],
      diagnostics: [],
      filesChecked: 5,
      errorCount: 0,
      warningCount: 0,
      success: true,
    };

    const out = formatLspResult(input);

    expect(out.diagnostics).toBe('Checked 5 files. No diagnostics found!');
    expect(out.summary).toBe('LSP check passed: 0 errors, 0 warnings (5 files)');
  });
});
