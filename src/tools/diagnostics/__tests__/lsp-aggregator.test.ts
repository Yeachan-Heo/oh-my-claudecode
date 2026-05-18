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
  it('surfaces install hints when language server is missing', async () => {
    mockGetServerForFile.mockReturnValue({ command: 'ty', installHint: 'Install ty from https://github.com/astral-sh/ty' });
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

  it('pre-check skips files with no registered language server', async () => {
    mockGetServerForFile
      .mockReturnValueOnce(null)
      .mockReturnValue({ command: 'ty', installHint: 'pip install ty' });
    mockRunWithClientLease.mockResolvedValue(undefined);

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
