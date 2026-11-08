import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error Local hook helper is a JS module loaded directly by the tests.
import { evaluateReadBudget } from '../../scripts/lib/read-budget-preflight.mjs';

type Evaluation = {
  decision: 'warn' | 'block';
  reason: string;
  path: string;
  lineCount: number;
  byteSize: number;
  trigger: 'bytes' | 'lines';
} | null;

describe('read budget preflight: binaries, pages, remedy order, byte budget (issue #4062)', () => {
  let cwd: string;
  let stateDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omc-read-budget-'));
    stateDir = join(cwd, '.state');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function evaluate(toolInput: Record<string, unknown>, config?: Record<string, unknown>): Evaluation {
    return evaluateReadBudget({
      toolName: 'Read',
      toolInput,
      stateDir,
      env: {},
      loadOmcConfig: () => ({ context: { readBudget: { mode: 'deny', ...(config || {}) } } }),
      cwd,
    }) as Evaluation;
  }

  function writeLines(name: string, lines: number): string {
    const filePath = join(cwd, name);
    writeFileSync(filePath, `${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`);
    return filePath;
  }

  it('skips a binary by extension instead of decoding it as UTF-8', () => {
    const pngPath = join(cwd, 'screenshot.png');
    // PNG magic + enough bytes to blow past both budgets.
    writeFileSync(pngPath, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200_000, 0xff),
    ]));

    expect(evaluate({ file_path: pngPath }, { maxBytes: 1000, maxLines: 1 })).toBeNull();
  });

  it('skips a text-named file that is actually binary via the NUL sniff', () => {
    const disguised = join(cwd, 'payload.txt');
    writeFileSync(disguised, Buffer.concat([
      Buffer.from('header\n'),
      Buffer.alloc(100_000, 0x00),
    ]));

    expect(evaluate({ file_path: disguised }, { maxBytes: 1000, maxLines: 1 })).toBeNull();
  });

  it('still gates a large text file that has no NUL bytes', () => {
    const big = writeLines('big.ts', 4000);

    const result = evaluate({ file_path: big }, { maxBytes: 1_000_000, maxLines: 100 });

    expect(result?.decision).toBe('block');
    expect(result?.trigger).toBe('lines');
    expect(result?.reason).toContain('4000 lines');
  });

  it('treats `pages` as a targeted range so a required PDF page read is not denied', () => {
    // A real PDF byte payload is not needed: `pages` short-circuits before any
    // file measurement, which is exactly the contract under test.
    const pdf = join(cwd, 'spec.pdf');
    writeFileSync(pdf, Buffer.alloc(200_000, 0x41));

    expect(evaluate({ file_path: pdf, pages: [1, 2] }, { maxBytes: 1000 })).toBeNull();
    expect(evaluate({ file_path: pdf, pages: '3-5' }, { maxBytes: 1000 })).toBeNull();
    expect(evaluate({ file_path: pdf, pages: 4 }, { maxBytes: 1000 })).toBeNull();
    expect(evaluate({ file_path: pdf, pages: [] }, { maxBytes: 1000 })).toBeNull(); // PDF is binary anyway
  });

  it('fires on bytes when the line count is under budget', () => {
    // 200 very long lines: far under any line budget, far over the byte budget.
    const dense = join(cwd, 'dense.json');
    writeFileSync(dense, `${Array.from({ length: 200 }, () => 'x'.repeat(500)).join('\n')}\n`);

    const result = evaluate({ file_path: dense }, { maxLines: 1500, maxBytes: 45000 });

    expect(result?.decision).toBe('block');
    expect(result?.trigger).toBe('bytes');
    expect(result?.reason).toContain('bytes (budget 45000)');
    // The byte path never decodes the file, so it must not invent a line count.
    expect(result?.reason).not.toContain('lines (budget');
  });

  it('honours an explicit maxBytes over the default', () => {
    const file = writeLines('medium.ts', 100);

    expect(evaluate({ file_path: file }, { maxBytes: 10, maxLines: 1500 })?.trigger).toBe('bytes');
    expect(evaluate({ file_path: file }, { maxBytes: 10_000_000, maxLines: 1500 })).toBeNull();
  });

  it('honours OMC_READ_BUDGET_MAX_BYTES for one-off runs', () => {
    const file = writeLines('env.ts', 100);

    const result = evaluateReadBudget({
      toolName: 'Read',
      toolInput: { file_path: file },
      stateDir,
      env: { OMC_READ_BUDGET_MAX_BYTES: '10' },
      loadOmcConfig: () => ({ context: { readBudget: { mode: 'deny' } } }),
      cwd,
    }) as Evaluation;

    expect(result?.decision).toBe('block');
    expect(result?.trigger).toBe('bytes');
  });

  it('honours OMC_READ_BUDGET_MAX_LINES for one-off runs', () => {
    const file = writeLines('env-lines-valid.ts', 100);

    const result = evaluateReadBudget({
      toolName: 'Read',
      toolInput: { file_path: file },
      stateDir,
      env: { OMC_READ_BUDGET_MAX_LINES: '50' },
      loadOmcConfig: () => ({ context: { readBudget: { mode: 'deny', maxBytes: 10_000_000 } } }),
      cwd,
    }) as Evaluation;

    expect(result?.decision).toBe('block');
    expect(result?.trigger).toBe('lines');
  });

  it('falls back when OMC_READ_BUDGET_MAX_BYTES has a malformed suffix', () => {
    const file = writeLines('env-bytes.ts', 100);

    const result = evaluateReadBudget({
      toolName: 'Read',
      toolInput: { file_path: file },
      stateDir,
      env: { OMC_READ_BUDGET_MAX_BYTES: '10kb' },
      loadOmcConfig: () => ({ context: { readBudget: { mode: 'deny', maxBytes: 10_000_000 } } }),
      cwd,
    }) as Evaluation;

    expect(result).toBeNull();
  });

  it('falls back when OMC_READ_BUDGET_MAX_LINES has a malformed suffix', () => {
    const file = writeLines('env-lines.ts', 100);

    const result = evaluateReadBudget({
      toolName: 'Read',
      toolInput: { file_path: file },
      stateDir,
      env: { OMC_READ_BUDGET_MAX_LINES: '50junk' },
      loadOmcConfig: () => ({
        context: { readBudget: { mode: 'deny', maxLines: 1_000, maxBytes: 10_000_000 } },
      }),
      cwd,
    }) as Evaluation;

    expect(result).toBeNull();
  });

  it('leads the remedy with a bounded re-read and demotes the structural tools', () => {
    const big = writeLines('ordered.ts', 4000);

    const reason = String(evaluate({ file_path: big }, { maxLines: 100, maxBytes: 1_000_000 })?.reason);

    expect(reason).toContain('`offset`/`limit`');
    expect(reason.indexOf('`offset`/`limit`')).toBeLessThan(reason.indexOf('lsp_document_symbols'));
    expect(reason.indexOf('subagent')).toBeLessThan(reason.indexOf('lsp_document_symbols'));
  });
});
