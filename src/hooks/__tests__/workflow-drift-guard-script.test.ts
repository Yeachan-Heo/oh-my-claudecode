import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'workflow-drift-guard.mjs');
const TEMPLATE = join(ROOT, 'templates', 'hooks', 'workflow-drift-guard.mjs');
const QUESTION_REASON_MARKERS = ['AskUserQuestion', 'allowOther'];
const AMBIENT_PARENT_LANE_SENTINEL = 'OMC_WORKFLOW_DRIFT_GUARD_AMBIENT_LANE';

interface GuardResult {
  decision?: string;
  reason?: string;
  suppressOutput?: boolean;
  continue?: boolean;
}

function runGuard(input: Record<string, unknown>, env: Record<string, string> = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.DISABLE_OMC;
  delete cleanEnv.OMC_SKIP_HOOKS;
  const output = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...cleanEnv, ...env },
  });
  return JSON.parse(output) as GuardResult;
}

function guardInput(last_assistant_message: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: 'Stop', last_assistant_message, cwd: ROOT, ...extra };
}

function expectPass(result: GuardResult) {
  expect(result).toEqual({ suppressOutput: true });
}

function expectBlock(result: GuardResult) {
  expect(result.decision).toBe('block');
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason).not.toBe('');
  expect(result.continue).toBeUndefined();
  for (const marker of QUESTION_REASON_MARKERS) expect(result.reason).toContain(marker);
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-workflow-drift-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'index.ts'), 'export const ok = true;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function restoreEnvironment(name: 'DISABLE_OMC' | 'OMC_SKIP_HOOKS', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('workflow-drift-guard Stop hook', () => {
  it('has one exact Stop registration and byte-identical source/template scripts', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>>;
    };
    const registrations: Array<{ event: string; type?: string; command?: string; timeout?: number }> = [];

    for (const [event, groups] of Object.entries(manifest.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          if (hook.command?.includes('workflow-drift-guard.mjs')) registrations.push({ event, ...hook });
        }
      }
    }

    expect(registrations).toEqual([{
      event: 'Stop',
      type: 'command',
      command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/workflow-drift-guard.mjs',
      timeout: 3,
    }]);
    expect(readFileSync(SCRIPT).equals(readFileSync(TEMPLATE))).toBe(true);
  });

  it('uses canonical current-message evidence and preserves aliases', () => {
    const fixture = join(mkdtempSync(join(tmpdir(), 'omc-workflow-drift-transcript-')), 'transcript.txt');
    writeFileSync(fixture, 'I found two viable paths. Which approach should I take?\n');
    expectPass(runGuard(guardInput('Should I proceed?', { transcript_path: fixture })));

    writeFileSync(fixture, 'Should I proceed?\n');
    expectBlock(runGuard(guardInput('PostgreSQL or SQLite?', { transcript_path: fixture })));
    expectPass(runGuard(guardInput('Should I proceed?')));
    expectBlock(runGuard(guardInput('PostgreSQL or SQLite?')));
    expectPass(runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'Should I proceed?',
      lastAssistantMessage: 'PostgreSQL or SQLite?',
      message: 'PostgreSQL or SQLite?',
      output: 'PostgreSQL or SQLite?',
      response: 'PostgreSQL or SQLite?',
      text: 'PostgreSQL or SQLite?',
      cwd: ROOT,
    }));

    for (const alias of ['lastAssistantMessage', 'message', 'output', 'response', 'text']) {
      expectBlock(runGuard({ hook_event_name: 'Stop', [alias]: 'PostgreSQL or SQLite?', cwd: ROOT }));
    }
  });

  it.each([
    ['PREC-EMPTY', ''],
    ['PREC-SPACE', '   '],
  ])('%s does not fall through from a present canonical key', (_id, last_assistant_message) => {
    expectPass(runGuard({
      hook_event_name: 'Stop',
      last_assistant_message,
      message: 'PostgreSQL or SQLite?',
      cwd: ROOT,
    }));
  });

  it.each([
    ['BQ-01', 'Would you prefer PostgreSQL or SQLite?'],
    ['BQ-02', 'Do you prefer PostgreSQL or SQLite?'],
    ['BQ-03', 'Should I migrate now or keep the compatibility layer?'],
    ['BQ-04', 'PostgreSQL or SQLite?'],
    ['DOT-01', 'PostgreSQL.v2 or v2?'],
    ['CLOSE-01', 'PostgreSQL or SQLite? )'],
    ['AS-01', 'PostgreSQL and SQLite are viable options. Which option should I choose?'],
    ['AS-03', 'PostgreSQL and SQLite are viable options; the other module is unchanged. Which option should I choose?'],
    ['AS-09', 'PostgreSQL Primary and SQLite Replica are viable options. Which option should I choose?'],
    ['DOT-02', 'PostgreSQL.v2 and v2 are viable options. Which option should I choose?'],
    ['C-01', 'I found two viable paths. Which approach should I take?'],
    ['C-02', 'There are two viable options. Which option should I choose?'],
    ['C-03', 'Two viable approaches remain. Which approach should I use?'],
    ['C-07', 'One path was ruled out; two viable paths remain. Which approach should I take?'],
    ['C-08', 'One option was resolved; two viable options remain. Which option should I choose?'],
    ['C-09', 'One approach was discarded; two viable approaches remain. Which approach should I use?'],
    ['OL-01', 'Options:\n- PostgreSQL\n- SQLite\nWhich should I choose?'],
    ['OL-02', 'Options:\nA. Migrate now\nB. Keep the compatibility layer\nWhich should I choose?'],
    ['LIST-BLANK-01', 'Options:\n\n- PostgreSQL\n- SQLite\nWhich should I choose?'],
    ['MASK-PRELUDE-01', '`debug`\n\n- PostgreSQL\n- SQLite\nWhich should I choose?'],
    ['L-02', 'PostgreSQL, SQLite, and MySQL were considered; PostgreSQL was ruled out. Which should I choose?'],
    ['ATTACH-01', 'The PostgreSQL, SQLite, and MySQL were considered; PostgreSQL was ruled out. Which should I choose?'],
    ['L-06', 'PostgreSQL, PostgreSQL, and SQLite are viable options. Which option should I choose?'],
    ['L-09', 'Options:\n- PostgreSQL — ruled out\n- SQLite\n- MySQL\nWhich should I choose?'],
    ['L-12', 'Options:\n- PostgreSQL (discarded)\n- SQLite\n- MySQL\nWhich should I choose?'],
    ['M-13', 'PostgreSQL or SQLite? `debug?`'],
    ['M-17', 'const pattern = /unfinished\nPostgreSQL and SQLite are viable options. Which should I choose?'],
    ['FF-03', 'PostgreSQL and SQLite are viable options; the other module is unchanged. Which option should I choose?'],
    ['FF-04', 'The other module is unchanged. I found two viable paths. Which approach should I take?'],
    ['FF-05', 'Paste any value if needed. PostgreSQL and SQLite are viable options. Which should I choose?'],
    ['H-02', 'PostgreSQL and SQLite are viable options. Which should I choose?'],
  ])('%s blocks only a supported local selection fork', (_id, message) => {
    expectBlock(runGuard(guardInput(message)));
  });

  it.each([
    ['BQ-05', 'Should I proceed or not?'],
    ['BQ-06', 'Continue, yes or no?'],
    ['BQ-07', 'Should I continue or not continue?'],
    ['BQ-08', 'PostgreSQL or PostgreSQL?'],
    ['BQ-09', 'This or that?'],
    ['BQ-10', 'PostgreSQL or ?'],
    ['BQ-11', 'Pick PostgreSQL or SQLite?'],
    ['BQ-12', 'Choose PostgreSQL or SQLite?'],
    ['BQ-13', 'Select PostgreSQL or SQLite?'],
    ['BQ-14', 'Use PostgreSQL or SQLite?'],
    ['BQ-15', 'Can PostgreSQL or SQLite work?'],
    ['BQ-16', 'Could PostgreSQL or SQLite work?'],
    ['BQ-17', 'Does PostgreSQL or SQLite work?'],
    ['BQ-18', 'Is PostgreSQL or SQLite better?'],
    ['BQ-19', 'Are PostgreSQL or SQLite installed?'],
    ['BQ-20', 'Would you like me to use PostgreSQL or SQLite?'],
    ['BQ-21', 'Please choose PostgreSQL or SQLite?'],
    ['BQ-22', 'Will PostgreSQL or SQLite work?'],
    ['BQ-23', 'Which is faster, PostgreSQL or SQLite?'],
    ['BQ-24', 'What should use PostgreSQL or SQLite?'],
    ['BQ-25', 'PostgreSQL or SQLite or MySQL?'],
    ['BQ-26', 'Would you prefer PostgreSQL and MySQL or SQLite?'],
    ['BQ-27', 'Would you prefer PostgreSQL or SQLite and MySQL?'],
    ['BQ-28', 'PostgreSQL or Other/free-form?'],
    ['BQ-29', 'PostgreSQL or choose?'],
    ['AS-02', 'PostgreSQL and SQLite are viable. I ran the tests. Which should I choose?'],
    ['AS-04', 'PostgreSQL and SQLite are viable. Which database is faster?'],
    ['AS-05', 'PostgreSQL and SQLite were considered; PostgreSQL was ruled out. Should I proceed?'],
    ['AS-06', 'PostgreSQL and Other/free-form are viable options. Which option should I choose?'],
    ['AS-07', 'This and PostgreSQL are viable options. Which option should I choose?'],
    ['AS-08', 'PostgreSQL and PostgreSQL are viable options. Which option should I choose?'],
    ['AS-10', 'Research and Development and SQLite are viable options. Which option should I choose?'],
    ['C-04', 'I found two viable paths, but one path was ruled out. Which approach should I take?'],
    ['C-05', 'There are two viable options, but one option was resolved. Which option should I choose?'],
    ['C-06', 'I found two viable approaches, but one approach was already chosen. Which approach should I use?'],
    ['C-10', 'Only one path remains. Which approach should I take?'],
    ['C-11', 'Only one option remains. Which option should I choose?'],
    ['C-12', 'Only one approach remains. Which approach should I use?'],
    ['C-13', 'I found a couple viable paths. Which approach should I take?'],
    ['C-14', 'I found two possible paths. Which approach should I take?'],
    ['C-15', 'I found two viable paths, but one path got ruled out. Which approach should I take?'],
    ['OL-03', 'Options:\n- PostgreSQL\n- SQLite\nI ran the tests.\nWhich should I choose?'],
    ['OL-04', '> - PostgreSQL\n> - SQLite\nWhich should I choose?'],
    ['OL-05', 'Options:\n• PostgreSQL\n• SQLite\nWhich should I choose?'],
    ['OL-06', 'Options:\n- PostgreSQL: ruled out\n- SQLite\n- MySQL\nWhich should I choose?'],
    ['OL-07', 'Options:\n- PostgreSQL\n- SQLite\n- Other/free-form\nWhich should I choose?'],
    ['OL-08', 'Options:\n- This\n- PostgreSQL\nWhich should I choose?'],
    ['OL-09', 'Options:\n- PostgreSQL\n- PostgreSQL\nWhich should I choose?'],
    ['M-01', 'The log says "PostgreSQL or SQLite?" Which should I choose?'],
    ['M-02', 'The note says “PostgreSQL or SQLite?” Which should I choose?'],
    ['M-03', 'Use `PostgreSQL or SQLite?`. Which should I choose?'],
    ['M-04', '```js\nPostgreSQL or SQLite?\n```\nWhich should I choose?'],
    ['M-05', '~~~txt\nPostgreSQL or SQLite?\n~~~\nWhich should I choose?'],
    ['M-06', '```js\nPostgreSQL or SQLite?'],
    ['M-07', '~~~txt\nPostgreSQL or SQLite?'],
    ['M-08', '"PostgreSQL or SQLite? Which should I choose?'],
    ['M-09', 'const pattern = /PostgreSQL|SQLite?/; Which should I choose?'],
    ['M-10', 'const pattern = /PostgreSQL|SQLite? Which should I choose?'],
    ['M-11', 'const mode = preferSql ? PostgreSQL : SQLite; Which should I choose?'],
    ['M-12', 'I will proceed. `PostgreSQL or SQLite?`'],
    ['M-14', 'PostgreSQL or SQLite? Thanks.'],
    ['M-15', 'Should I proceed? `debug?`'],
    ['M-16', '> PostgreSQL or SQLite?'],
    ['M-18', 'PostgreSQL and /unfinished SQLite are viable options. Which should I choose?'],
    ['MASK-01', 'PostgreSQL and mode:/unfinished SQLite are viable options. Which should I choose?'],
    ['M-19', 'PostgreSQL or SQLite?\n`unterminated'],
    ['M-20', 'PostgreSQL or SQLite?\nconst mode = preferSql ? PostgreSQL'],
    ['BOUNDARY-01', 'Which is faster,\nPostgreSQL or SQLite?'],
    ['L-01', 'PostgreSQL, SQLite, and MySQL were considered; PostgreSQL was ruled out and SQLite was eliminated. Which should I choose?'],
    ['L-03', 'PostgreSQL and SQLite were considered; only SQLite remains. Which should I choose?'],
    ['L-04', 'PostgreSQL and SQLite were considered; PostgreSQL was already chosen. Which should I choose?'],
    ['L-05', 'PostgreSQL, SQLite, and MySQL were considered; one was ruled out. Which should I choose?'],
    ['L-07', 'PostgreSQL and PostgreSQL are viable. Which should I choose?'],
    ['L-08', 'This, that, and PostgreSQL are options. Which should I choose?'],
    ['L-10', 'Options:\n- PostgreSQL — ruled out\n- SQLite — eliminated\n- MySQL\nWhich should I choose?'],
    ['L-11', 'PostgreSQL and SQLite were considered; PostgreSQL was deprecated. Which should I choose?'],
    ['L-13', 'Options:\n- PostgreSQL - ruled out\n- SQLite\n- MySQL\nWhich should I choose?'],
    ['L-14', 'PostgreSQL, SQLite, and MySQL were considered; PostgreSQL was ruled out, SQLite was eliminated. Which should I choose?'],
    ['L-15', 'PostgreSQL and SQLite were considered; MySQL was ruled out. Which should I choose?'],
    ['L-16', 'PostgreSQL, PostgreSQL, and SQLite were considered; PostgreSQL was ruled out. Which should I choose?'],
    ['FF-01', 'Options:\n- PostgreSQL\n- SQLite\n- Other/free-form\nWhich should I choose?'],
    ['FF-02', 'PostgreSQL and SQLite are viable options, or paste the exact connection string. Which should I use?'],
    ['FF-06', 'PostgreSQL and SQLite are viable options, or say anything else you want. Which should I choose?'],
    ['FF-07', 'Please choose PostgreSQL, SQLite, or Other/free-form?'],
    ['FF-08', 'PostgreSQL or Other/free-form?'],
    ['FF-09', 'PostgreSQL and Other/free-form are viable options. Which option should I choose?'],
    ['P-01', 'Should I proceed?'],
    ['P-02', 'Would you like me to continue?'],
    ['P-03', '이대로 진행할까요?'],
    ['P-04', 'I can proceed with the fix now. 이대로 진행할까요?'],
    ['P-05', 'Who would want that?'],
    ['P-06', 'I can proceed. Who would want that?'],
    ['H-01', 'Should I proceed?'],
  ])('%s fails open for unsupported, ambiguous, or open-input syntax', (_id, message) => {
    expectPass(runGuard(guardInput(message)));
  });

  it('uses no history or invocation state', () => {
    const input = guardInput('PostgreSQL and SQLite are viable options. Which should I choose?', {
      prior_tool_calls: [{ name: 'AskUserQuestion', input: { question: 'Database?', options: ['PostgreSQL', 'SQLite'] } }],
    });
    expectBlock(runGuard(input));
  });

  it('fails open while already continuing from a Stop hook', () => {
    expectPass(runGuard(guardInput('PostgreSQL or SQLite?', { stop_hook_active: true })));
    expectPass(runGuard(guardInput('PostgreSQL or SQLite?', { stopHookActive: true })));
  });

  it('is deterministic across repeated pass and block invocations', () => {
    expectPass(runGuard(guardInput('Should I proceed?')));
    expectPass(runGuard(guardInput('Should I proceed?')));
    expectBlock(runGuard(guardInput('PostgreSQL or SQLite?')));
    expectBlock(runGuard(guardInput('PostgreSQL or SQLite?')));
  });

  it('honors explicit skip controls only when supplied to the child process', () => {
    expectPass(runGuard(guardInput('PostgreSQL or SQLite?'), { DISABLE_OMC: '1' }));
    expectPass(runGuard(guardInput('PostgreSQL or SQLite?'), { DISABLE_OMC: 'true' }));
    expectPass(runGuard(guardInput('PostgreSQL or SQLite?'), { OMC_SKIP_HOOKS: 'workflow-drift-guard' }));
  });

  it('clears ambient skip controls before each normal child-process case', () => {
    const disable = process.env.DISABLE_OMC;
    const skip = process.env.OMC_SKIP_HOOKS;
    try {
      process.env.DISABLE_OMC = '1';
      process.env.OMC_SKIP_HOOKS = 'workflow-drift-guard';
      expectBlock(runGuard(guardInput('PostgreSQL or SQLite?')));
      expectPass(runGuard(guardInput('PostgreSQL or SQLite?'), { DISABLE_OMC: '1' }));
    } finally {
      restoreEnvironment('DISABLE_OMC', disable);
      restoreEnvironment('OMC_SKIP_HOOKS', skip);
    }
  });

  it.skipIf(process.env[AMBIENT_PARENT_LANE_SENTINEL] === '1')('passes the complete suite with disabled ambient parent variables', () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.DISABLE_OMC;
    delete cleanEnv.OMC_SKIP_HOOKS;
    expect(() => execFileSync('npm', ['exec', 'vitest', '--', 'run', 'src/hooks/__tests__/workflow-drift-guard-script.test.ts'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        DISABLE_OMC: '1',
        OMC_SKIP_HOOKS: 'workflow-drift-guard',
        [AMBIENT_PARENT_LANE_SENTINEL]: '1',
      },
      stdio: 'pipe',
    })).not.toThrow();
  });

  it('blocks completion claims when changed code adds skipped tests', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.test.ts'), "import { test } from 'vitest';\ntest.skip('covers the edge case', () => {});\n");

    const result = runGuard({ hook_event_name: 'Stop', last_assistant_message: 'Implemented and complete.', cwd });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('skipped test');
    expect(result.reason).toContain('index.test.ts');
  });

  it('allows ready-to-continue wording while work is not being claimed complete', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');

    expectPass(runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'I am ready to continue after checking the next step.',
      cwd,
    }));
  });

  it('reports real file line numbers for tracked-file blockers', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), [
      'export const ok = true;',
      '',
      'export function later() {',
      '  const value = 1;',
      '  return value;',
      '  // TODO: implement blocker',
      '}',
    ].join('\n'));

    const result = runGuard({ hook_event_name: 'Stop', last_assistant_message: 'Implemented and complete.', cwd });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('index.ts:6');
  });

  it('allows TODO blockers while work is not being claimed complete', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');

    expectPass(runGuard({
      hook_event_name: 'Stop',
      last_assistant_message: 'I found the next implementation step and will continue after checking tests.',
      cwd,
    }));
  });

  it('allows detector and test fixture literals that mention blocker patterns', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'fixtures.ts'), [
      'const regex = /\\b(?:stub|placeholder|not implemented|unimplemented)\\b/i;',
      'const sampleTodo = "// TODO: implement fixture";',
      'const skippedTestFixture = "test.skip(\'covers fixture\', () => {})";',
    ].join('\n'));

    expectPass(runGuard({ hook_event_name: 'Stop', last_assistant_message: 'Implemented and complete.', cwd }));
  });
});
