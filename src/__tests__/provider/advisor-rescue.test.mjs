/* global process */
// The advisor model parameter used by the rescue hooks (OMC_PROVIDER_ADVISOR_MODEL): the model reaches claude as --model and the journal row, the default is
// opus, a wrong value is refused with exit code 2 before the start. Fake claude, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAdvisorClaude, runAdvisor } from './_advisor-helpers.mjs';
import { makeTmp } from './_helpers.mjs';

// Each case starts several node processes; on a loaded machine that takes longer than the default limit.
vi.setConfig({ testTimeout: 180000 });

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
});
