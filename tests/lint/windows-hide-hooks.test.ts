import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');

const RECURRING_HOOK_SCRIPTS = [
  'scripts/pre-tool-enforcer.mjs',
  'scripts/post-tool-verifier.mjs',
  'scripts/context-guard-stop.mjs',
  'scripts/code-simplifier.mjs',
] as const;

const CHILD_PROCESS_CALL = /\b(execSync|execFileSync|spawn|spawnSync)\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*\{([\s\S]*?)\}\s*\)/g;
const WINDOWS_HIDE_TRUE = /\bwindowsHide\s*:\s*true\b/;

function toForwardSlash(path: string): string {
  return path.split(sep).join('/');
}

describe('Windows hook child-process hardening', () => {
  it('recurring hook scripts hide nested child_process calls on Windows', () => {
    const violations: string[] = [];
    const scannedCalls: string[] = [];

    for (const script of RECURRING_HOOK_SCRIPTS) {
      const absolutePath = join(REPO_ROOT, script);
      const content = readFileSync(absolutePath, 'utf-8');
      const linesBefore = (index: number) => content.slice(0, index).split('\n').length;

      for (const match of content.matchAll(CHILD_PROCESS_CALL)) {
        const callName = match[1];
        const optionsBlock = match[2] ?? '';
        const line = linesBefore(match.index ?? 0);
        scannedCalls.push(`${script}:${callName}`);

        if (!WINDOWS_HIDE_TRUE.test(optionsBlock)) {
          violations.push(`${toForwardSlash(relative(REPO_ROOT, absolutePath))}:${line}: ${callName} missing windowsHide: true`);
        }
      }
    }

    expect(scannedCalls).toEqual([
      'scripts/pre-tool-enforcer.mjs:execSync',
      'scripts/pre-tool-enforcer.mjs:execSync',
      'scripts/pre-tool-enforcer.mjs:execSync',
      'scripts/post-tool-verifier.mjs:execSync',
      'scripts/post-tool-verifier.mjs:execSync',
      'scripts/post-tool-verifier.mjs:execSync',
      'scripts/context-guard-stop.mjs:execSync',
      'scripts/code-simplifier.mjs:execSync',
    ]);
    expect(violations).toEqual([]);
  });
});
