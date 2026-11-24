/**
 * The shared loader of the text cleaning module (scripts/lib/context-text-loader.mjs), and a hook that uses it, run as
 * subprocesses from a copy of the scripts in a temporary directory. The copy has no cleaning module, so the import fails
 * with the switch on, and the hook must write the same text as with the switch off.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import process from 'node:process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RTL = String.fromCodePoint(0x202E);
const WIKI_TEXT = `wiki index${RTL} text`;

// A copy of the loader and of the wiki session start hook with the files they import, in a temporary plugin root. The
// built wiki module is a stub that returns WIKI_TEXT. The cleaning module is copied only when `withSanitizer` is true.
function withPluginCopy(withSanitizer, run) {
  const root = mkdtempSync(join(tmpdir(), 'context-text-loader-'));
  try {
    const lib = join(root, 'scripts', 'lib');
    mkdirSync(lib, { recursive: true });
    mkdirSync(join(root, 'dist', 'hooks', 'wiki'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    copyFileSync(join(REPO_ROOT, 'scripts', 'wiki-session-start.mjs'), join(root, 'scripts', 'wiki-session-start.mjs'));
    for (const file of ['context-text-loader.mjs', 'stdin.mjs', ...(withSanitizer ? ['context-text-sanitize.mjs'] : [])]) {
      copyFileSync(join(REPO_ROOT, 'scripts', 'lib', file), join(lib, file));
    }
    writeFileSync(
      join(root, 'dist', 'hooks', 'wiki', 'session-hooks.js'),
      `export function onSessionStart() { return { additionalContext: ${JSON.stringify(WIKI_TEXT)} }; }\n`,
    );
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runNode(args, input, switchValue) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|CODEX|DISABLE_OMC)/i.test(key)));
  if (switchValue !== undefined) env.OMC_CONTEXT_TEXT_SANITIZE = switchValue;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, input, timeout: 30000 });
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function loaderResult(root, switchValue) {
  const loaderUrl = pathToFileURL(join(root, 'scripts', 'lib', 'context-text-loader.mjs')).href;
  const code = `const { loadContextText } = await import(${JSON.stringify(loaderUrl)});\n`
    + 'const loaded = await loadContextText();\n'
    + 'console.log(JSON.stringify(loaded === null ? null : typeof loaded.cleanHostText));';
  return JSON.parse(runNode(['--input-type=module', '-e', code], '', switchValue));
}

function wikiHookOutput(root, switchValue) {
  const out = runNode([join(root, 'scripts', 'wiki-session-start.mjs')], JSON.stringify({ cwd: root }), switchValue);
  return JSON.parse(out);
}

describe('context-text-loader.mjs', () => {
  it('returns the cleaning module when the switch is 1 or true, and null for every other value', () => {
    withPluginCopy(true, (root) => {
      for (const value of ['1', 'true', ' TRUE ']) expect(loaderResult(root, value), `value ${JSON.stringify(value)}`).toBe('function');
      for (const value of [undefined, '', '0', 'false', 'yes', '2']) expect(loaderResult(root, value), `value ${JSON.stringify(value)}`).toBeNull();
    });
  });

  it('returns null without throwing when the switch is on and the cleaning module cannot be imported', () => {
    withPluginCopy(false, (root) => {
      expect(loaderResult(root, '1')).toBeNull();
      expect(loaderResult(root, 'true')).toBeNull();
    });
  });

  it('lets a hook write its text unchanged when the switch is on and the cleaning module is missing', () => {
    withPluginCopy(false, (root) => {
      const off = wikiHookOutput(root, '0');
      const on = wikiHookOutput(root, '1');
      expect(on).toEqual(off);
      expect(on.hookSpecificOutput.additionalContext).toBe(WIKI_TEXT);
      expect(on.hookSpecificOutput.additionalContext).toContain(RTL);
    });
  });

  it('cleans the same hook text when the module is present (control for the case above)', () => {
    withPluginCopy(true, (root) => {
      const on = wikiHookOutput(root, '1');
      expect(on.hookSpecificOutput.additionalContext).toBe('wiki index  text');
      expect(wikiHookOutput(root, '0').hookSpecificOutput.additionalContext).toBe(WIKI_TEXT);
    });
  });
});
