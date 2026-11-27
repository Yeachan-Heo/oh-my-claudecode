import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionStandaloneStateLockBridge } from '../installer/index.js';
import {
  detectKeywordsWithType,
  isUnderspecifiedForExecution,
  sanitizeForKeywordDetection,
} from '../hooks/keyword-detector/index.js';
import { isShortRalphFollowupRequest, isShortTeamFollowupRequest } from '../team/followup-planner.js';

// The keyword detector runs on every prompt under a hook timeout, so no prompt may
// cost it more than linear time. Long runs of blank lines or spaces used to take
// quadratic or cubic time in several patterns of the three detector copies.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_ROOT = mkdtempSync(join(tmpdir(), 'keyword-detector-linear-'));
cpSync(join(root, 'scripts'), join(WORK_ROOT, 'scripts'), { recursive: true });
cpSync(join(root, 'templates', 'hooks'), join(WORK_ROOT, 'hooks'), { recursive: true });
provisionStandaloneStateLockBridge(root, join(WORK_ROOT, 'hooks', 'lib', 'state-lock.mjs'));
afterAll(() => rmSync(WORK_ROOT, { recursive: true, force: true }));

const HOOKS = [
  { name: 'plugin hook', path: join(WORK_ROOT, 'scripts', 'keyword-detector.mjs') },
  { name: 'standalone template hook', path: join(WORK_ROOT, 'hooks', 'keyword-detector.mjs') },
];

// Generous budgets: every input below needs well under a second, and far longer than
// the budget when a pattern rescans a run from each of its positions.
const HOOK_BUDGET_MS = 10000;
const CALL_BUDGET_MS = 2000;

const spaces = (count: number) => ' '.repeat(count);

const HOOK_INPUTS: Array<[string, string]> = [
  ['blank lines', '\n'.repeat(20000)],
  ['blank CRLF lines', '\r\n'.repeat(10000)],
  ['indented blank lines', `${spaces(80)}\n`.repeat(1500)],
  ['blank lines left by removed quote lines', '> quoted line\n'.repeat(10000)],
  ['spaces inside an unfinished self-closing tag', `see <a${spaces(200000)}y`],
  ['spaces after an angle bracket', `<${spaces(200000)}y`],
  ['ideographic spaces', `see${'\u3000'.repeat(200000)}y`],
  ['spaces after a command keyword', `please run autopilot${spaces(200000)}x`],
  ['spaces inside the line before a command', `docs${spaces(200000)}x\nautopilot fix it`],
  ['blank lines after a keyword', `use tdd${'\n'.repeat(100000)}x`],
  // Patterns that need a non-Latin character cost nothing on a Latin-only prompt.
  ['blank lines in a non-Latin prompt', `notes about tdd${'\n'.repeat(150000)}\u30b3`],
  ['spaces after a workflow name without a task', `/autopilot --workflow a${spaces(200000)}`],
];

function runHook(detectorPath: string, prompt: string) {
  const home = mkdtempSync(join(WORK_ROOT, 'run-'));
  try {
    return spawnSync(process.execPath, [detectorPath], {
      cwd: home,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: home, session_id: 'session-linear', prompt }),
      encoding: 'utf-8',
      timeout: HOOK_BUDGET_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: '',
        OMC_TEAM_WORKER: '',
        OMC_STATE_DIR: join(home, 'omc-state'),
        CLAUDE_PLUGIN_ROOT: '',
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('keyword detector time on long whitespace runs', () => {
  describe.each(HOOKS)('$name', ({ path }) => {
    it.each(HOOK_INPUTS)('answers within the budget for %s', (_label, prompt) => {
      const run = runHook(path, prompt);

      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ continue: true });
    });
  });

  const CALLS: Array<[string, () => unknown]> = [
    ['sanitizing blank lines', () => sanitizeForKeywordDetection('\n'.repeat(3000))],
    ['sanitizing an unfinished self-closing tag', () => sanitizeForKeywordDetection(`see <a${spaces(100000)}y`)],
    ['sanitizing spaces after an angle bracket', () => sanitizeForKeywordDetection(`<${spaces(100000)}y`)],
    ['sanitizing ideographic spaces', () => sanitizeForKeywordDetection(`see${'\u3000'.repeat(100000)}y`)],
    ['detecting a command before long spaces', () => detectKeywordsWithType(`please run autopilot${spaces(100000)}x`)],
    ['detecting after a long line before a command', () => detectKeywordsWithType(`docs${spaces(100000)}x\nautopilot fix it`)],
    ['detecting a keyword before blank lines', () => detectKeywordsWithType(`use tdd${'\n'.repeat(60000)}x`)],
    ['detecting a mention in a non-Latin prompt', () => detectKeywordsWithType(`notes about tdd${'\n'.repeat(60000)}\u30b3`)],
    ['looking for a list item among blank lines', () => isUnderspecifiedForExecution(`go${'\n'.repeat(60000)}x`)],
    ['matching a team follow-up after long spaces', () => isShortTeamFollowupRequest(`${spaces(100000)}x`)],
    ['matching a ralph follow-up after long spaces', () => isShortRalphFollowupRequest(`${spaces(100000)}x`)],
  ];

  // A vm timeout also interrupts a regular expression that is still backtracking.
  it.each(CALLS)('stays within the budget when %s', (_label, call) => {
    let failure: string | undefined;
    try {
      vm.runInNewContext('call()', { call }, { timeout: CALL_BUDGET_MS });
    } catch (error) {
      failure = (error as NodeJS.ErrnoException).code ?? String(error);
    }

    expect(failure).toBeUndefined();
  }, 30000);
});

// Differential check: the rewritten patterns must give the same result as the earlier,
// slow ones. The earlier patterns are kept here as the reference.
/* eslint-disable no-misleading-character-class -- The detector's script ranges: an intentional range set, not grapheme clusters */
const SEGMENT = '[\\w.\\-\\u3000-\\u9FFF\\uAC00-\\uD7AF\\u0400-\\u04FF\\u0600-\\u06FF\\u0900-\\u097F\\u0E00-\\u0E7F\\u1000-\\u109F]';
const EARLIER_PATH = `(?:\\/)?(?:${SEGMENT}+\\/)+(?:${SEGMENT}*\\.\\w+|[\\w.\\-]+)`;

function stripEarlierRules(text: string, url: RegExp, path: RegExp, pathReplacement: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1(?:[ \t][^<>\r\n]*)?>/g, '')
    .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '')
    .replace(url, '')
    .replace(/^\s*>\s.*$/gm, '')
    .replace(/^\s*\|(?:[^|\n]*\|){2,}\s*$/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/gm, '')
    .replace(path, pathReplacement);
}

const earlierHookSanitize = (text: string) =>
  stripEarlierRules(text, /https?:\/\/[^\s)>\]]+/g, new RegExp(`(?<=^|[\\s"'\`(])${EARLIER_PATH}`, 'gm'), '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '');

const earlierExportedSanitize = (text: string) =>
  stripEarlierRules(text, /https?:\/\/\S+/g, new RegExp(`(^|[\\s"'\`(])${EARLIER_PATH}`, 'gm'), '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`]+`/g, '');

// Small deterministic generator, so a failure always reproduces.
function randomStrings(tokens: string[], count: number, maxTokens: number, seed: number): string[] {
  let state = seed;
  const next = (bound: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % bound;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + next(maxTokens) }, () => tokens[next(tokens.length)]).join(''));
}

const SPACING = [' ', ' ', '\t', '\n', '\n', '\n', '\r', '\r\n', '\u00a0', '\u3000', '\u3000', '\u2028'];

const SANITIZE_CASES = [
  'text\n\n> quoted line\nrest',
  '> first\r\n> second\r\nafter',
  '>\nthe line after a bare marker is removed with it\nkept',
  ' \n\t > indented quote\n\n  > another',
  'a > b\n>not a quote\n> > nested',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\nafter',
  '| a | b |\r\n| :--- | ---: |\r\n| 1 | 2 |\r\n',
  'before\n\n\n---|---|\n\n\nafter',
  '|\n---\n|\n---\n|\nafter',
  '---\n|---\n|---\n|x',
  '| a | b | trailing words\nnext | a | b |',
  '|---|\n\n> q\n\n|a|b|\n\n| --- |',
  '| one pipe only |',
  '--|\ntwo dashes are not a separator\n:--|--:|\n|--|\nkept',
  '<a   /> <b x="1" /> <c\n\n/> <d  / > <e/> <f x\n/>',
  'see \u3000src/a.ts and \u3000\u3000lib/b.js and w\u3000\u3000c/d and "\u3000\u3000/e/f',
  '\u3000\u3000\u3000/src/x.ts\n\u3000>\u3000full width quote\n\u3000|a|b|',
  '\u00a0> non-breaking\n\u00a0\u00a0|a|b|\u00a0\n\u00a0|---|',
];

const SANITIZE_CORPUS = [
  ...SANITIZE_CASES,
  ...randomStrings(
    ['>', '> ', '|', '|', '---', '----', ':', '-', 'w', 'x', '.ts', '/', '<a', '/>', '<', '=', '"', '(', '`', '\u30b3', ...SPACING],
    6000,
    28,
    7,
  ),
  ...randomStrings(['|', '|', '---', '--', ':', ...SPACING], 4000, 18, 11),
  ...randomStrings(['>', 'w', ...SPACING], 2000, 14, 13),
  ...randomStrings(['\u3000', '\u3000', '\u3000', ' ', '\n', '(', '/', 'w', '.', 'ts'], 3000, 14, 17),
];

const ROLE_CORPUS = randomStrings(['<', '<', '/', '/', ' ', ' ', '\t', '\u3000', 'user', 'system', 'tool_use', 'x', '>'], 4000, 10, 19);
const LABEL_CORPUS = randomStrings(['\uacb0\ub860', '\uc124\uba85', '\uc694\uc57d', ':', '\uff1a', 'x', ...SPACING], 4000, 10, 23);
const HEADING_CORPUS = randomStrings(['docs', 'Summary', 'release', 'notes', 'keyword', ':', ':', 'x', ' ', ' ', '\t', '\n'], 4000, 8, 29);

const EARLIER_ROLE = /^<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/i;
const EARLIER_LABEL = /(?:^|\n)\s*(?:\uacb0\ub860|\ud2b9\uc9d5|\uc608\uc2dc|\uc694\uc57d|\uc7a5\uc810|\ub2e8\uc810|\uc124\uba85)\s*[:\uff1a]/u;
const EARLIER_HEADING = /^[ \t]*(?:docs?|documentation|summary|status|logs?|release\s+notes|changelog|readme|examples?|output|result|results|description|title|commit|trigger|triggers|keywords?)[ \t]*:?[ \t]*$/i;

function differences<T>(corpus: string[], actual: T[], expected: (input: string) => T) {
  return corpus
    .map((input, index) => ({ input, actual: actual[index], expected: expected(input) }))
    .filter((entry) => JSON.stringify(entry.actual) !== JSON.stringify(entry.expected))
    .slice(0, 3);
}

// Loads one hook copy with its final main() call replaced by an export, and runs the
// functions and patterns on the corpora in a separate process.
function probeHook(detectorPath: string) {
  const source = readFileSync(detectorPath, 'utf-8');
  expect(source).toMatch(/\nmain\(\);\n$/);
  const modulePath = detectorPath.replace(/\.mjs$/, '.probe.mjs');
  writeFileSync(modulePath, source.replace(
    /\nmain\(\);\n$/,
    '\nexport { sanitizeForKeywordDetection, ROLE_BOUNDARY_PATTERN, REFERENCE_EXPLANATION_PATTERNS, AUTOPILOT_REFERENCE_HEADING };\n',
  ));
  const probe = `
    import { readFileSync } from 'node:fs';
    const hook = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const corpora = JSON.parse(readFileSync(0, 'utf-8'));
    process.stdout.write(JSON.stringify({
      sanitized: corpora.sanitize.map((input) => hook.sanitizeForKeywordDetection(input)),
      role: corpora.role.map((input) => hook.ROLE_BOUNDARY_PATTERN.exec(input)?.slice(0, 2) ?? null),
      label: corpora.label.map((input) => hook.REFERENCE_EXPLANATION_PATTERNS[0].test(input)),
      heading: corpora.heading.map((input) => hook.AUTOPILOT_REFERENCE_HEADING.test(input)),
    }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    input: JSON.stringify({ sanitize: SANITIZE_CORPUS, role: ROLE_CORPUS, label: LABEL_CORPUS, heading: HEADING_CORPUS }),
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as {
    sanitized: string[];
    role: Array<string[] | null>;
    label: boolean[];
    heading: boolean[];
  };
}

describe('keyword detector rewritten patterns match the earlier ones', () => {
  it.each(HOOKS)('$name sanitizes and classifies like before', ({ path }) => {
    const result = probeHook(path);

    expect(differences(SANITIZE_CORPUS, result.sanitized, earlierHookSanitize)).toEqual([]);
    expect(differences(ROLE_CORPUS, result.role, (input) => EARLIER_ROLE.exec(input)?.slice(0, 2) ?? null)).toEqual([]);
    expect(differences(LABEL_CORPUS, result.label, (input) => EARLIER_LABEL.test(input))).toEqual([]);
    expect(differences(HEADING_CORPUS, result.heading, (input) => EARLIER_HEADING.test(input))).toEqual([]);
  }, 90000);

  it('the exported sanitizer removes the same text as before', () => {
    const actual = SANITIZE_CORPUS.map((input) => sanitizeForKeywordDetection(input));

    expect(differences(SANITIZE_CORPUS, actual, earlierExportedSanitize)).toEqual([]);
  });

  it('the corpus reaches every rewritten sanitizer rule', () => {
    const rules = [
      /<\w[\w-]*(?:\s[^>]*)?\s*\/>/,
      /^\s*>\s.*$/m,
      /^\s*\|(?:[^|\n]*\|){2,}\s*$/m,
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/m,
      new RegExp(`(?<=^|[\\s"'\`(])${EARLIER_PATH}`, 'm'),
      /\u3000\u3000[\w.]*\//,
    ];

    for (const rule of rules) {
      expect(SANITIZE_CORPUS.filter((input) => rule.test(input)).length).toBeGreaterThan(20);
    }
    for (const [corpus, rule] of [[ROLE_CORPUS, EARLIER_ROLE], [LABEL_CORPUS, EARLIER_LABEL], [HEADING_CORPUS, EARLIER_HEADING]] as const) {
      expect(corpus.filter((input) => rule.test(input)).length).toBeGreaterThan(20);
    }
  });

  it('the list item signal of the execution gate is unchanged', () => {
    const earlierListItem = /(?:^|\n)\s*(?:\d+[.)]\s|-\s+\S|\*\s+\S)/m;
    // Short prompts without any other signal: only the list item decides the answer.
    const corpus = randomStrings(['it', 'now', '-', '*', '1.', '2)', ...SPACING], 4000, 12, 31)
      .filter((input) => input.trim() !== '');
    const actual = corpus.map((input) => isUnderspecifiedForExecution(input));

    expect(corpus.filter((input) => earlierListItem.test(input.trim())).length).toBeGreaterThan(20);
    expect(differences(corpus, actual, (input) => !earlierListItem.test(input.trim()))).toEqual([]);
  });

  it('the short follow-up requests are unchanged', () => {
    const corpus = randomStrings(['team', 'ralph', 'Team', '/', '/', 'x', ...SPACING], 4000, 7, 37);
    const earlierTeam = (input: string) => /^\s*\/?\s*team\s*$/i.test(input);
    const earlierRalph = (input: string) => /^\s*\/?\s*ralph\s*$/i.test(input);

    expect(corpus.filter(earlierTeam).length).toBeGreaterThan(20);
    expect(corpus.filter(earlierRalph).length).toBeGreaterThan(20);
    expect(differences(corpus, corpus.map(isShortTeamFollowupRequest), earlierTeam)).toEqual([]);
    expect(differences(corpus, corpus.map(isShortRalphFollowupRequest), earlierRalph)).toEqual([]);
  });
});

describe.each([
  ['plugin', join(root, 'scripts', 'lib', 'workflow-profile-runtime.mjs')],
  ['standalone template', join(root, 'templates', 'hooks', 'lib', 'workflow-profile-runtime.mjs')],
])('%s workflow invocation parser', (_name, libraryPath) => {
  it('reads the workflow name and task as before', async () => {
    const { parseWorkflowInvocation } = await import(pathToFileURL(libraryPath).href) as {
      parseWorkflowInvocation: (prompt: string) => { kind: string; workflowName?: string; task?: string };
    };
    const earlier = (invocation: string) => {
      const match = invocation.match(/^\s*--workflow\s+(\S+)(?:\s+([\s\S]*?\S))?\s*$/);
      return match?.[2] && /^[a-z][a-z0-9-]{0,62}$/.test(match[1])
        ? { kind: 'valid', workflowName: match[1], task: match[2] }
        : { kind: 'invalid-explicit-workflow-invocation' };
    };
    const corpus = randomStrings(['a', 'b-1', 'A', '.', ...SPACING], 4000, 9, 41).map((rest) => `--workflow ${rest}`);
    const actual = corpus.map((invocation) => {
      const { kind, workflowName, task } = parseWorkflowInvocation(`/autopilot ${invocation}`);
      return kind === 'valid' ? { kind, workflowName, task } : { kind };
    });

    expect(corpus.filter((invocation) => earlier(invocation).kind === 'valid').length).toBeGreaterThan(20);
    expect(differences(corpus, actual, earlier)).toEqual([]);
  });
});
