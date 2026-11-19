/**
 * Formatter selection of scripts/session-start.mjs for the project memory summary (OMC_PROJECT_MEMORY_FRAME). The hook runs
 * as a subprocess against a temporary plugin root whose built formatter is a fixture: one that exports only the bare
 * formatter (a build made before the framed variant existed) and one that also exports an asynchronous framed variant.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import process from 'node:process';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'session-start.mjs');

const BARE_FORMATTER = "export function formatContextSummary() { return 'BARE-SUMMARY'; }\n";
const FRAMED_FORMATTER = `${BARE_FORMATTER}export async function formatContextSummaryWithFrame() { return 'FRAMED-SUMMARY'; }\n`;

// Reports what the hook passes to the formatter: the number of arguments, and the names of the writers when it passes them.
const ARGUMENT_FORMATTER = "export function formatContextSummary(memory, context, writers) { return writers ? `WRITERS:${Object.keys(writers).sort().join(',')}` : `NO-WRITERS:${arguments.length}`; }\n";

// Runs the hook once per call with `variable` as OMC_PROJECT_MEMORY_FRAME (undefined = not set) and returns its context text.
function sessionStartContext(formatterSource, variable, extraEnv = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'session-start-memory-frame-'));
  try {
    const pluginRoot = join(sandbox, 'plugin');
    const projectDir = join(sandbox, 'project');
    const stubs = {
      'storage.js': "export async function loadProjectMemory() { return { customNotes: [{ category: 'note', content: 'kept' }] }; }\n",
      'detector.js': 'export async function detectProjectEnvironment() { return null; }\n',
      'formatter.js': formatterSource,
    };
    mkdirSync(join(pluginRoot, 'dist', 'hooks', 'project-memory'), { recursive: true });
    mkdirSync(join(pluginRoot, 'dist', 'hooks', 'rules-injector'), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const [file, source] of Object.entries(stubs)) writeFileSync(join(pluginRoot, 'dist', 'hooks', 'project-memory', file), source);
    writeFileSync(join(pluginRoot, 'dist', 'hooks', 'rules-injector', 'finder.js'), 'export function findProjectRoot(directory) { return directory; }\n');
    execFileSync('git', ['init', '-q'], { cwd: projectDir, stdio: 'ignore' });

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|CODEX|DISABLE_OMC)/i.test(key)));
    Object.assign(env, {
      HOME: sandbox,
      USERPROFILE: sandbox,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
      OMC_STATE_DIR: join(sandbox, 'state'),
      OMC_NOTIFY: '0',
    });
    if (variable !== undefined) env.OMC_PROJECT_MEMORY_FRAME = variable;
    Object.assign(env, extraEnv);
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: projectDir,
      input: JSON.stringify({ cwd: projectDir, session_id: 'sess-memory-frame', hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      env,
      timeout: 55000,
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    return String(JSON.parse(result.stdout.trim()).hookSpecificOutput?.additionalContext ?? '');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('session-start project memory formatter selection', () => {
  it('uses the framed formatter, and awaits its asynchronous result, when the variable is 1 or true', () => {
    for (const value of ['1', 'true', ' TRUE ']) {
      const text = sessionStartContext(FRAMED_FORMATTER, value);
      expect(text, `value ${JSON.stringify(value)}`).toContain('<project-memory-context>');
      expect(text, `value ${JSON.stringify(value)}`).toContain('FRAMED-SUMMARY');
      expect(text, `value ${JSON.stringify(value)}`).not.toContain('BARE-SUMMARY');
    }
  }, 120000);

  it('falls back to the bare formatter when the built formatter has no framed variant', () => {
    const text = sessionStartContext(BARE_FORMATTER, '1');
    expect(text).toContain('<project-memory-context>');
    expect(text).toContain('BARE-SUMMARY');
    expect(text).not.toContain('FRAMED-SUMMARY');
  }, 60000);

  it('writes the same context as the bare formatter when the variable is not set or has another value', () => {
    const baseline = sessionStartContext(BARE_FORMATTER, undefined);
    expect(baseline).toContain('BARE-SUMMARY');
    for (const value of [undefined, '', '0', 'false', 'yes', '2']) {
      const text = sessionStartContext(FRAMED_FORMATTER, value);
      expect(text, `value ${JSON.stringify(value)}`).not.toContain('FRAMED-SUMMARY');
      expect(text, `value ${JSON.stringify(value)}`).toBe(baseline);
    }
  }, 180000);
});

describe('session-start passes the cleaning writers to the project memory formatter', () => {
  it('passes the module, and only the module, as the third argument when OMC_CONTEXT_TEXT_SANITIZE is 1 or true', () => {
    for (const value of ['1', 'true']) {
      const text = sessionStartContext(ARGUMENT_FORMATTER, undefined, { OMC_CONTEXT_TEXT_SANITIZE: value });
      expect(text, value).toContain('WRITERS:');
      for (const name of ['cleanHostText', 'cleanTextBlock', 'escapeIdentifier', 'escapeRemovedCharacters', 'fitLines']) expect(text, value).toContain(name);
    }
  }, 120000);

  it('calls the formatter with the memory alone, as before, when the switch is off or unset', () => {
    for (const extra of [{}, { OMC_CONTEXT_TEXT_SANITIZE: '0' }, { OMC_CONTEXT_TEXT_SANITIZE: 'yes' }]) {
      const text = sessionStartContext(ARGUMENT_FORMATTER, undefined, extra);
      expect(text, JSON.stringify(extra)).toContain('NO-WRITERS:1');
    }
  }, 180000);

  it('leaves a summary that holds escaped identifiers as it is when it cleans the block', () => {
    const escapedPath = JSON.stringify('project-\u2699\ufe0f/file.ts').replace('\ufe0f', '\\ufe0f').replace('\u2699', '\\u2699');
    const summary = `[Hot Paths]\n- ${escapedPath} (3x)`;
    const formatter = `export function formatContextSummary() { return ${JSON.stringify(summary)}; }\n`;
    const text = sessionStartContext(formatter, undefined, { OMC_CONTEXT_TEXT_SANITIZE: '1' });
    expect(text).toContain(`- ${escapedPath} (3x)`);
  }, 60000);
});

// A summary whose hot paths are long identifiers. When the aggregate SessionStart budget cuts the memory section, the cut is by
// whole lines (with the text cleaning switch or the frame on), so no path is left half written and the envelope stays closed.
const HOT_PATHS = [1, 2, 3].map((n) => `src/${'d'.repeat(130)}/file-${n}.ts`);
const SUMMARY = ['[REFERENCE ONLY] a short frame', '', '[Hot Paths]', ...HOT_PATHS.map((path, index) => `- ${path} (${3 - index}x)`)].join('\n');
const SUMMARY_FORMATTER = `export function formatContextSummary() { return ${JSON.stringify(SUMMARY)}; }\nexport async function formatContextSummaryWithFrame() { return ${JSON.stringify(SUMMARY)}; }\n`;
const CUT_NOTICE = '...[truncated to preserve SessionStart context budget]';
const SECTION_END = '</project-memory-context>';

// The budget that puts the character cut in the middle of the second path.
function budgetInsideSecondPath() {
  const full = sessionStartContext(SUMMARY_FORMATTER, '1');
  return full.indexOf(HOT_PATHS[1]) + 100;
}

describe('session-start cuts the memory section by whole lines when the aggregate budget is short', () => {
  it('keeps every written path whole and the closing tag when the frame is on', () => {
    const budget = budgetInsideSecondPath();
    const text = sessionStartContext(SUMMARY_FORMATTER, '1', { OMC_SESSION_START_CONTEXT_BUDGET: String(budget) });
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain(`- ${HOT_PATHS[0]} (3x)`);
    expect(text).not.toContain('file-2');
    expect(text).toContain(CUT_NOTICE);
    expect(text).toContain(`${SECTION_END}\n`);
    for (const line of text.split('\n').filter((entry) => entry.startsWith('- '))) expect(SUMMARY.split('\n')).toContain(line);
  }, 120000);

  it('does the same when only the text cleaning switch is on', () => {
    const budget = budgetInsideSecondPath();
    const text = sessionStartContext(SUMMARY_FORMATTER, undefined, { OMC_CONTEXT_TEXT_SANITIZE: '1', OMC_SESSION_START_CONTEXT_BUDGET: String(budget) });
    expect(text).toContain(`- ${HOT_PATHS[0]} (3x)`);
    expect(text).not.toContain('file-2');
    expect(text).toContain(`${SECTION_END}\n`);
  }, 60000);

  it('keeps the whole section when it fits, and for every budget keeps only whole lines', () => {
    const full = sessionStartContext(SUMMARY_FORMATTER, '1');
    expect(sessionStartContext(SUMMARY_FORMATTER, '1', { OMC_SESSION_START_CONTEXT_BUDGET: String(full.length) })).toBe(full);
    for (const budget of [full.length - 1, full.length - 100, full.indexOf(HOT_PATHS[2]) + 40, 400, 150]) {
      const text = sessionStartContext(SUMMARY_FORMATTER, '1', { OMC_SESSION_START_CONTEXT_BUDGET: String(budget) });
      expect(text.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      for (const line of text.split('\n').filter((entry) => entry.startsWith('- '))) expect(SUMMARY.split('\n'), `budget ${budget}`).toContain(line);
      if (text.includes(CUT_NOTICE)) expect(text, `budget ${budget}`).toContain(`${SECTION_END}\n`);
    }
  }, 240000);

  it('keeps a 147 character hot path whole, or leaves it out, with the frame on and a budget of 800', () => {
    const path = `src/${'p'.repeat(134)}/hot-1.ts`;
    expect(path.length).toBe(147);
    const summary = [`[REFERENCE ONLY] ${'frame text '.repeat(52).trim()}`, '', '[Hot Paths]', `- ${path} (3x)`, `- ${path.replace('hot-1', 'hot-2')} (2x)`].join('\n');
    const formatter = `export function formatContextSummary() { return ${JSON.stringify(summary)}; }\nexport async function formatContextSummaryWithFrame() { return ${JSON.stringify(summary)}; }\n`;
    const text = sessionStartContext(formatter, '1', { OMC_SESSION_START_CONTEXT_BUDGET: '800' });
    expect(text.length).toBeLessThanOrEqual(800);
    for (const line of text.split('\n').filter((entry) => entry.startsWith('- '))) expect(summary.split('\n')).toContain(line);
    expect(text).toContain(CUT_NOTICE);
    expect(text).toContain(`${SECTION_END}\n`);
  }, 120000);

  it('still cuts by characters, as before, when the switch and the frame are off', () => {
    const budget = budgetInsideSecondPath();
    const text = sessionStartContext(SUMMARY_FORMATTER, undefined, { OMC_SESSION_START_CONTEXT_BUDGET: String(budget) });
    expect(text.split('src/dddd').length - 1, 'the second path is cut in the middle').toBe(2);
    expect(text).not.toContain('file-2');
    expect(text).not.toContain(SECTION_END);
    expect(text.endsWith(`\n${CUT_NOTICE}`)).toBe(true);
  }, 120000);
});
