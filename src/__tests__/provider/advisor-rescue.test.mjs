/* global process */
// The advisor model parameter used by the rescue hooks (OMC_PROVIDER_ADVISOR_MODEL): the model reaches claude as --model and the journal row, the default is
// opus, a wrong value is refused with exit code 2 before the start. Fake claude, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADVISOR, fakeAdvisorClaude, runAdvisor } from './_advisor-helpers.mjs';
import { makeTmp } from './_helpers.mjs';

// Each case starts several node processes; on a loaded machine that takes longer than the default limit.
vi.setConfig({ testTimeout: 180000 });

const require = createRequire(import.meta.url);
const hook = require('../../../scripts/provider/provider-hook-rescue.cjs');
const { advisorControls } = require('../../../scripts/provider/lib/env.cjs');
const js = JSON.stringify;
const check = (condition, message) => expect(Boolean(condition), typeof message === 'function' ? message() : message).toBe(true);

describe.skipIf(process.platform === 'win32')('advisor model for the rescue consultation', () => {
  let tmp; let TMP; let FAKE; let JOURNAL; let n = 0;
  const consult = (override = {}) => runAdvisor({
    env: { PATH: process.env.PATH, HOME: TMP, OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL, ...override },
    argv: ['Why does the test fail?'],
    fakeOut: join(TMP, `r${++n}`),
  });
  const lastRow = () => (existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, 'utf8').trim().split('\n').at(-1)) : null);
  const rowCount = () => (existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').trim().split('\n').length : 0);

  beforeAll(() => {
    tmp = makeTmp('provider-advisor-rescue-');
    TMP = tmp.dir;
    FAKE = fakeAdvisorClaude(TMP);
    JOURNAL = join(TMP, 'data', 'advisor.jsonl');
  });
  afterAll(() => tmp.cleanup());

  it('(11) provider-advisor: the model from OMC_PROVIDER_ADVISOR_MODEL in --model (sonnet), opus by default, the model field in the journal row', () => {
    const r = consult({ OMC_PROVIDER_ADVISOR_MODEL: 'sonnet' });
    check(r.status === 0 && r.argv && r.argv.includes('--model') && r.argv[r.argv.indexOf('--model') + 1] === 'sonnet', `the sonnet model in argv: ${js(r.argv)}`);
    check(lastRow().model === 'sonnet', `the model field in the journal: ${js(lastRow())}`);
    const d = consult({});
    check(d.status === 0 && d.argv[d.argv.indexOf('--model') + 1] === 'opus', 'opus by default');
  });
  it('(12) provider-advisor: a wrong value of OMC_PROVIDER_ADVISOR_MODEL: the consultation start is refused with exit code 2, claude not called, a row in the journal', () => {
    const before = rowCount();
    const r = consult({ OMC_PROVIDER_ADVISOR_MODEL: 'gpt-5' });
    check(r.status === 2, `exit code 2 (got ${r.status})`);
    check(r.argv === null, 'claude was called');
    check(/disallowed value/.test(r.stderr), 'a message on stderr');
    check(rowCount() === before + 1, 'a row in the journal');
  });
  it('(13) the command printed in the rescue package is accepted by the advisor with the lead switches of the session: plain, with the journal (--event test-failure --failure-no N), with the shaped input (DECISION field) and with both; the journal row carries the event and the failure number', () => {
    const state = { ...hook.initialState(), signature: 'sig0123456789abc', repeats: 2 };
    const sessions = [{}, { OMC_PROVIDER_ADVISOR_JOURNAL: '1' }, { OMC_PROVIDER_ADVISOR_INPUT: '1' }, { OMC_PROVIDER_ADVISOR_JOURNAL: '1', OMC_PROVIDER_ADVISOR_INPUT: '1' }];
    for (const session of sessions) {
      const text = hook.rescuePackage('sig0123456789abc', 2, 'FAIL tests/x.mjs: 2 tests failed', state, { limit: 2 }, 'provider-advisor', { ...session, OMC_PROVIDER: 'acme' });
      const command = /exactly this command \(by its bare name\):\n {2}([\s\S]*?)\nA successful consultation/.exec(text)[1];
      check(command.startsWith('provider-advisor'), command);
      check((session.OMC_PROVIDER_ADVISOR_JOURNAL === '1') === command.includes('--event test-failure --failure-no 2'), `the event flags follow the journal switch: ${command}`);
      check((session.OMC_PROVIDER_ADVISOR_INPUT === '1') === command.includes('DECISION:'), `the DECISION field follows the input switch: ${command}`);
      const before = rowCount();
      const r = spawnSync('/bin/sh', ['-c', command.replace(/^provider-advisor/, '"$NODE" "$ADVISOR"')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: TMP, NODE: process.execPath, ADVISOR, FAKE_OUT: join(TMP, `r${++n}`), OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL, ...session },
        timeout: 60000,
      });
      check(r.status === 0 && r.stdout.includes('STUB-ANSWER'), `exit ${r.status} for ${js(session)}: ${r.stderr.slice(0, 200)}`);
      check(rowCount() > before, 'a row in the journal');
      if (session.OMC_PROVIDER_ADVISOR_JOURNAL === '1') {
        const end = readFileSync(JOURNAL, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((row) => row.type === 'end').at(-1);
        check(end.event === 'test-failure' && end.failure_no === 2, js(end));
      }
    }
  });
  it('(14) the lead has OMC_PROVIDER_ADVISOR_PROTOCOL=final (with the input and the journal on): the worker session gets no final protocol, so the consultation of the rescue package is accepted (exit 0, advice delivered, no gate failure)', () => {
    const lead = { OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_PROVIDER_ADVISOR_JOURNAL: '1', OMC_PROVIDER_ADVISOR_PROTOCOL: 'final' };
    const session = advisorControls(lead);
    check(!('OMC_PROVIDER_ADVISOR_PROTOCOL' in session) && session.OMC_PROVIDER_ADVISOR_INPUT === '1' && session.OMC_PROVIDER_ADVISOR_JOURNAL === '1', js(session));
    const state = { ...hook.initialState(), signature: 'sig0123456789abc', repeats: 2 };
    const text = hook.rescuePackage('sig0123456789abc', 2, 'FAIL tests/x.mjs: 2 tests failed', state, { limit: 2 }, 'provider-advisor', { ...session, OMC_PROVIDER: 'acme' });
    const command = /exactly this command \(by its bare name\):\n {2}([\s\S]*?)\nA successful consultation/.exec(text)[1];
    const r = spawnSync('/bin/sh', ['-c', command.replace(/^provider-advisor/, '"$NODE" "$ADVISOR"')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: TMP, NODE: process.execPath, ADVISOR, FAKE_OUT: join(TMP, `r${++n}`), OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL, ...session },
      timeout: 60000,
    });
    check(r.status === 0 && !/GATE:/.test(r.stdout), `exit ${r.status}: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
    // With the final protocol in the environment of the consultation (what the copy used to give) the same command fails the gate.
    const gated = spawnSync('/bin/sh', ['-c', command.replace(/^provider-advisor/, '"$NODE" "$ADVISOR"')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: TMP, NODE: process.execPath, ADVISOR, FAKE_OUT: join(TMP, `r${++n}`), OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL, ...session, OMC_PROVIDER_ADVISOR_PROTOCOL: 'final' },
      timeout: 60000,
    });
    check(gated.status === 3, `the final gate of the lead protocol refuses the rescue question: exit ${gated.status}`);
  });
});
