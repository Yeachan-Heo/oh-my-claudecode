import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionStandaloneStateLockBridge } from '../../../installer/index.js';
import { detectKeywordsWithType } from '../index.js';

// The autopilot command policy lives in three copies: the exported detector
// (src/hooks/keyword-detector/index.ts), scripts/keyword-detector.mjs and
// templates/hooks/keyword-detector.mjs. Each prompt below must give the same
// answer in all three.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT_PATH = join(root, 'scripts', 'keyword-detector.mjs');
const TEMPLATE_ROOT = mkdtempSync(join(tmpdir(), 'keyword-detector-parity-'));
const TEMPLATE_PATH = join(TEMPLATE_ROOT, 'hooks', 'keyword-detector.mjs');
cpSync(join(root, 'templates', 'hooks'), join(TEMPLATE_ROOT, 'hooks'), { recursive: true });
provisionStandaloneStateLockBridge(root, join(TEMPLATE_ROOT, 'hooks', 'lib', 'state-lock.mjs'));
afterAll(() => rmSync(TEMPLATE_ROOT, { recursive: true, force: true }));

let runCounter = 0;

function hookActivatesAutopilot(detectorPath: string, prompt: string): boolean {
  const workDir = mkdtempSync(join(tmpdir(), 'keyword-detector-parity-run-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: workDir, stdio: 'pipe' });
    const raw = execFileSync(process.execPath, [detectorPath], {
      cwd: workDir,
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: workDir,
        session_id: `session-parity-${++runCounter}`,
        prompt,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: '',
        OMC_TEAM_WORKER: '',
        OMC_STATE_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        HOME: workDir,
        USERPROFILE: workDir,
        CLAUDE_CONFIG_DIR: join(workDir, '.claude'),
      },
      timeout: 15000,
    }).trim();
    const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: string } };
    return (parsed.hookSpecificOutput?.additionalContext ?? '').includes('[MAGIC KEYWORD: AUTOPILOT]');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function exportedDetectorActivatesAutopilot(prompt: string): boolean {
  return detectKeywordsWithType(prompt).some((match) => match.type === 'autopilot');
}

const COMMANDS = [
  'autopilot build a todo CLI',
  'autopilot: build the thing',
  'Fix the cron first.\nautopilot test the API',
  'Fix the cron first.\nautopilot review the patch',
  'Fix the cron first.\nautopilot: bring the db up',
  'Fix the cron first.\nautopilot: ping the server',
  'Fix the cron first.\nautopilot: seed the database',
  'Fix the cron first.\nautopilot, fix the parser',
  'Fix the cron first.\nautopilot; fix the parser',
  'Fix the cron first.\nautopilot — fix the parser',
  'Fix the cron first.\nautopilot - fix the parser',
  'Please use the full auto on this task',
  'Please use the fullsend on this task',
  'use autopilot to fix the login bug',
  'use "autopilot" to implement the login page',
  'please autopilot the migration',
  'auto-pilot: refactor the parser',
  '/oh-my-claudecode:autopilot fix the bug',
  '/omc:autopilot fix the bug',
  '$autopilot ship it',
  'autopilot',
  'build me an app for tracking habits',
  `${'please autopilot? what is it?\n'.repeat(25)}Then do the work.\n$autopilot fix the bug`,
];

const NON_COMMANDS = [
  'Fix the cron first.\nautopilot: waiting for a task',
  'Fix the cron first.\nautopilot: complete',
  'Fix the cron first.\nautopilot test suite is red',
  'Fix the cron first.\nautopilot review is done',
  'Fix the cron first.\nautopilot, which is nice',
  'The full auto mode is neat',
  'The autopilot run failed on step 3',
  'Add tests (autopilot at cap; 12 of 20 done)',
  "don't use autopilot for this",
  'Docs: use autopilot for long tasks',
  '"autopilot" implement the login page',
  'How do I use autopilot?',
  'abc1234 autopilot test the thing',
  'The article compares ralph and autopilot workflows, and explains how they differ.',
  'Docs say "use autopilot" as an example.',
];

describe('autopilot command policy parity across the three detector copies', () => {
  it.each(COMMANDS)('all copies activate autopilot for %j', (prompt) => {
    expect(exportedDetectorActivatesAutopilot(prompt)).toBe(true);
    expect(hookActivatesAutopilot(SCRIPT_PATH, prompt)).toBe(true);
    expect(hookActivatesAutopilot(TEMPLATE_PATH, prompt)).toBe(true);
  }, 60000);

  it.each(NON_COMMANDS)('no copy activates autopilot for %j', (prompt) => {
    expect(exportedDetectorActivatesAutopilot(prompt)).toBe(false);
    expect(hookActivatesAutopilot(SCRIPT_PATH, prompt)).toBe(false);
    expect(hookActivatesAutopilot(TEMPLATE_PATH, prompt)).toBe(false);
  }, 60000);
});
