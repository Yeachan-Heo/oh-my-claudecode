import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;

function runKeywordDetector(
  prompt: string,
  cwd = process.cwd(),
  sessionId = 'session-2053',
  env: NodeJS.ProcessEnv = {},
) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: sessionId,
      prompt,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OMC_SKIP_HOOKS: '',
      ...env,
    },
    timeout: 15000,
  }).trim();

  return JSON.parse(raw) as {
    continue: boolean;
    suppressOutput?: boolean;
    hookSpecificOutput?: {
      hookEventName?: string;
      additionalContext?: string;
    };
  };
}

function getRalplanStatePath(cwd: string, sessionId: string) {
  return join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
}

describe('keyword-detector.mjs mode-message dispatch', () => {
  it('injects search mode for deepsearch without emitting a magic skill invocation', () => {
    const output = runKeywordDetector('deepsearch the codebase for keyword dispatch');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(context).toContain('<search-mode>');
    expect(context).toContain('MAXIMIZE SEARCH EFFORT');
    expect(context).not.toContain('[MAGIC KEYWORD: DEEPSEARCH]');
    expect(context).not.toContain('Skill: oh-my-claudecode:deepsearch');
  });

  it.each([
    ['ultrathink', '<think-mode>'],
    ['deep-analyze this subsystem', '<analyze-mode>'],
    ['tdd fix the failing test', '<tdd-mode>'],
    ['code review this diff', '<code-review-mode>'],
    ['security review this auth flow', '<security-review-mode>'],
  ])('keeps mode keyword %s on the context-injection path', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain(marker);
    expect(context).not.toContain('[MAGIC KEYWORD:');
  });

  it.each([
    ['テストファーストで実装して', '<tdd-mode>'],
    ['テスト ファースト で実装して', '<tdd-mode>'],
    ['コードレビューして', '<code-review-mode>'],
    ['セキュリティレビューお願いします', '<security-review-mode>'],
    ['ディープサーチでコードベースを探して', '<search-mode>'],
    ['ディープアナライズして', '<analyze-mode>'],
  ])('routes Japanese mode keyword %s to the context-injection path', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain(marker);
    expect(context).not.toContain('[MAGIC KEYWORD:');
  });

  it.each([
    ['ディープインタビューしたい', '[MAGIC KEYWORD: DEEP-INTERVIEW]'],
    ['シーシージーで実装して', '[MAGIC KEYWORD: CCG]'],
  ])('emits magic keyword invocation for Japanese skill keyword %s', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain(marker);
  });

  it.each([
    ['コードレビューとは何ですか', '<code-review-mode>'],
    ['テストファーストの使い方を教えて', '<tdd-mode>'],
    ['ディープサーチと普通の検索の違いを教えて', '<search-mode>'],
    ['ディープアナライズと分析の違いを教えて', '<analyze-mode>'],
  ])('suppresses Japanese informational question %s', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).not.toContain(marker);
  });

  it.each([
    ['docs/コードレビュー.mdを読んで', '<code-review-mode>'],
    ['src/セキュリティレビュー.ts を開いて', '<security-review-mode>'],
    ['notes/ディープアナライズ.md を見て', '<analyze-mode>'],
  ])('does not activate a mode for a CJK file path %s', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).not.toContain(marker);
  });

  // Regression: a no-space Japanese directive after a path must NOT be eaten by the
  // path stripper (the .ext anchor bounds the match at the file name) — issue r3367755945.
  it.each([
    ['src/auth.tsをコードレビューして', '<code-review-mode>'],
    ['lib/parser.tsをディープアナライズして', '<analyze-mode>'],
  ])('still activates a mode when a no-space CJK directive follows a path %s', (prompt, marker) => {
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain(marker);
  });

  it('still emits magic keyword invocation for true skills like ralplan', () => {
    const output = runKeywordDetector('ralplan fix issue #2053');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');
    expect(context).toContain('Preferred invocation: /oh-my-claudecode:ralplan');
    expect(context).not.toContain('name: ralplan');
  });

  it('does not emit or activate ralplan for informational/question mentions', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-info-'));
    const sessionId = 'session-2619-info';
    const output = runKeywordDetector(
      'Verify the actual UserPromptSubmit/stop-hook path that activates ralplan state, reproduce the false activation on non-task keyword mention.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralplanStatePath = getRalplanStatePath(cwd, sessionId);

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPLAN]');
    expect(existsSync(ralplanStatePath)).toBe(false);
  });

  it('still activates ralplan state for a true ralplan task invocation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-task-'));
    const sessionId = 'session-2619-task';
    const output = runKeywordDetector('please use ralplan to plan issue #2053', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralplanStatePath = getRalplanStatePath(cwd, sessionId);

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');
    expect(existsSync(ralplanStatePath)).toBe(true);

    const state = JSON.parse(readFileSync(ralplanStatePath, 'utf-8')) as {
      active?: boolean;
      awaiting_confirmation?: boolean;
    };
    expect(state.active).toBe(true);
    expect(state.awaiting_confirmation).toBe(true);
  });

  it('launches the approved Team follow-up instead of re-entering ralplan when OMX planning artifacts already exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-followup-'));
    const sessionId = 'session-2714-followup';
    const sessionStateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);
    const omxPlansDir = join(cwd, '.omx', 'plans');

    mkdirSync(sessionStateDir, { recursive: true });
    mkdirSync(omxPlansDir, { recursive: true });

    writeFileSync(
      join(sessionStateDir, 'ralplan-state.json'),
      JSON.stringify(
        {
          active: false,
          session_id: sessionId,
          current_phase: 'complete',
          completed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(omxPlansDir, 'prd-capture-page-ui-draft.md'),
      [
        '# PRD',
        '',
        '## Acceptance criteria',
        '- done',
        '',
        '## Requirement coverage map',
        '- req -> impl',
        '',
        'omx team ".omx/plans/ralplan-capture-page-ui-draft-v7.md"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(omxPlansDir, 'test-spec-capture-page-ui-draft.md'),
      [
        '# Test Spec',
        '',
        '## Unit coverage',
        '- unit',
        '',
        '## Verification mapping',
        '- verify',
        '',
      ].join('\n'),
    );

    const output = runKeywordDetector('team', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('TEAM');
    expect(context).not.toContain('[MAGIC KEYWORD: RALPLAN]');
  });

  it('does not launch execution follow-up while ralplan is still active after compact continuation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-compact-readonly-'));
    const sessionId = 'session-3122-compact-active';
    const sessionStateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);
    const omxPlansDir = join(cwd, '.omx', 'plans');

    mkdirSync(sessionStateDir, { recursive: true });
    mkdirSync(omxPlansDir, { recursive: true });

    writeFileSync(
      join(sessionStateDir, 'ralplan-state.json'),
      JSON.stringify(
        {
          active: true,
          session_id: sessionId,
          current_phase: 'ralplan',
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(omxPlansDir, 'prd-compact-readonly.md'),
      [
        '# PRD',
        '',
        '## Acceptance criteria',
        '- done',
        '',
        '## Requirement coverage map',
        '- req -> impl',
        '',
        'omx team ".omx/plans/ralplan-compact-readonly.md"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(omxPlansDir, 'test-spec-compact-readonly.md'),
      [
        '# Test Spec',
        '',
        '## Unit coverage',
        '- unit',
        '',
        '## Verification mapping',
        '- verify',
        '',
      ].join('\n'),
    );

    for (const prompt of ['team', 'ralph']) {
      const output = runKeywordDetector(prompt, cwd, sessionId);
      const context = output.hookSpecificOutput?.additionalContext ?? '';

      expect(output.continue).toBe(true);
      expect(context).not.toContain('TEAM');
      expect(context).not.toContain('RALPH');
      expect(context).not.toContain('[MAGIC KEYWORD: RALPLAN]');
    }
  });

  it('does not launch execution follow-up from a pending approval plan without a launch hint', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-no-hint-'));
    const sessionId = 'session-3122-no-hint';
    const sessionStateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);
    const omxPlansDir = join(cwd, '.omx', 'plans');

    mkdirSync(sessionStateDir, { recursive: true });
    mkdirSync(omxPlansDir, { recursive: true });

    writeFileSync(
      join(sessionStateDir, 'ralplan-state.json'),
      JSON.stringify(
        {
          active: false,
          session_id: sessionId,
          current_phase: 'pending_approval',
          completed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(omxPlansDir, 'prd-compact-readonly.md'),
      [
        '# PRD',
        '',
        '## Acceptance criteria',
        '- done',
        '',
        '## Requirement coverage map',
        '- req -> impl',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(omxPlansDir, 'test-spec-compact-readonly.md'),
      [
        '# Test Spec',
        '',
        '## Unit coverage',
        '- unit',
        '',
        '## Verification mapping',
        '- verify',
        '',
      ].join('\n'),
    );

    for (const prompt of ['team', 'ralph']) {
      const output = runKeywordDetector(prompt, cwd, sessionId);
      const context = output.hookSpecificOutput?.additionalContext ?? '';

      expect(output.continue).toBe(true);
      expect(context).not.toContain('TEAM');
      expect(context).not.toContain('RALPH');
      expect(context).not.toContain('[MAGIC KEYWORD: RALPLAN]');
    }
  });

  it('does not activate ralplan from a delegated /ask codex payload', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'keyword-detector-ask-codex-'));

    try {
      const sessionId = 'ask-codex-session';
      const output = runKeywordDetector(
        '/ask codex 지금까지 논의한걸 ralplan으로 계획서 작성해줘',
        tempDir,
        sessionId,
      );

      expect(output.continue).toBe(true);
      expect(output.suppressOutput).toBe(true);
      expect(output.hookSpecificOutput).toBeUndefined();
      expect(existsSync(join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not activate a magic keyword from a delegated /ask antigravity payload', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'keyword-detector-ask-antigravity-'));

    try {
      const sessionId = 'ask-antigravity-session';
      const output = runKeywordDetector(
        '/ask antigravity please ralph through the remaining cleanup tasks',
        tempDir,
        sessionId,
      );

      expect(output.continue).toBe(true);
      expect(output.suppressOutput).toBe(true);
      expect(output.hookSpecificOutput).toBeUndefined();
      expect(existsSync(join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes ralplan startup state and init context for explicit /ralplan slash invoke', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-slash-'));

    try {
      const sessionId = 'slash-ralplan-session';
      const output = runKeywordDetector('/oh-my-claudecode:ralplan issue #2622', tempDir, sessionId);
      const context = output.hookSpecificOutput?.additionalContext ?? '';

      expect(output.continue).toBe(true);
      expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
      expect(context).toContain('[RALPLAN INIT]');
      expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');

      const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
      expect(existsSync(statePath)).toBe(true);

      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
        active?: boolean;
        current_phase?: string;
        awaiting_confirmation?: boolean;
        awaiting_confirmation_set_at?: string;
        original_prompt?: string;
      };

      expect(state.active).toBe(true);
      expect(state.current_phase).toBe('ralplan');
      expect(state.awaiting_confirmation).toBe(true);
      expect(typeof state.awaiting_confirmation_set_at).toBe('string');
      expect(state.original_prompt).toBe('/oh-my-claudecode:ralplan issue #2622');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores HTML comments that mention ralph and autopilot during normal review text', () => {
    const output = runKeywordDetector(`Please review this draft document for tone and clarity:

<!-- ralph: rewrite intro section with more urgency -->
<!-- autopilot note: Why Artificially Inflating GitHub Star Counts Is Harmful:
popularity without merit misleads developers, distorts discovery, unfairly rewards dishonest projects, and erodes trust in GitHub stars as a community signal. -->

Final draft:

Why Artificially Inflating GitHub Star Counts Is Harmful
=========================================================

This article argues that fake popularity signals damage trust in open source.`);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(context).toBe('');
  });

  it('does not activate ultrawork for issue #2474 explanatory comparison text', () => {
    const output = runKeywordDetector(`🦌 DeerFlow vs ⚡ OMC Ultrawork - 완전 비교!
...
OMC Ultrawork = "특수부대 작전 반"
...
결론: "순식간에 많은 작업" → OMC Ultrawork ⚡
이런대화가 한번이라면 몇번할수있을까 오픈라우터 20달러 결제기준 api로`);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(context).toBe('');
  });

  it('does not re-trigger on quoted follow-up references to ultrawork', () => {
    const output = runKeywordDetector('The article said "OMC Ultrawork", but why is the answer the same?');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(context).toBe('');
  });

  it('does not activate ultrawork for single-mode explanatory definitions followed by a budget question', () => {
    const output = runKeywordDetector('OMC Ultrawork = "special ops". how much would it cost?');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(context).toBe('');
  });

  it('does not branch pasted skill transcript payloads into a fresh Ralph invocation', () => {
    const output = runKeywordDetector(`Investigate why this pasted transcript branched sessions:

[MAGIC KEYWORD: RALPH]
Skill: oh-my-claudecode:ralph
User request:
ralph fix parser`);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(context).toBe('');
  });

  it('does not branch pasted shell transcript lines into fresh skill invocations', () => {
    const output = runKeywordDetector(`Summarize this log:
$ ralph fix parser
$ ultrawork search the codebase`);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toBe('');
  });

  it('does not branch pasted git diff hunks into fresh skill invocations', () => {
    const output = runKeywordDetector(`Please explain this diff:
diff --git a/a b/b
--- a/a
+++ b/b
@@ -1,2 +1,2 @@
+ ralph fix parser
+ autopilot build me an app`);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toBe('');
  });

  // Regression: issue #2541 — review-seed echo must not trip code-review / security-review alerts
  it('does not activate code-review when prompt is echoed review-instruction text with approve/request-changes/merge-ready', () => {
    const prompt = [
      'You are performing a code review of PR #2541.',
      'Reply with exactly one verdict:',
      '- approve',
      '- request-changes',
      '- merge-ready',
    ].join('\n');
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: CODE-REVIEW]');
    expect(context).not.toContain('<code-review-mode>');
    expect(context).toBe('');
  });

  it('does not activate security-review when prompt is echoed review-instruction text with approve/request-changes/blocked', () => {
    const prompt = [
      'You are performing a security review.',
      'Choose one verdict:',
      '- approve',
      '- request-changes',
      '- blocked',
    ].join('\n');
    const output = runKeywordDetector(prompt);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: SECURITY-REVIEW]');
    expect(context).not.toContain('<security-review-mode>');
    expect(context).toBe('');
  });

  it('still activates code-review for a genuine user request (positive control)', () => {
    const output = runKeywordDetector('code review this diff');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('<code-review-mode>');
    expect(context).not.toContain('[MAGIC KEYWORD: CODE-REVIEW]');
  });

  it.each([
    'so does this not print out status each epoch via rich cli? don\'t stop anything',
    'spawn subagent. Ralph is randomly trigger. open issue ...',
  ])('does not activate ralph for issue #3411 false-positive prompt: %s', (prompt) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-3411-negative-'));
    const sessionId = `session-3411-negative-${prompt.replace(/\W+/g, '-').slice(0, 80)}`;
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(false);
  });

  it.each([
    '/oh-my-claudecode:ralph issue #3411',
    'ralph this',
  ])('still activates ralph for issue #3411 explicit invocation: %s', (prompt) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-3411-positive-'));
    const sessionId = `session-3411-positive-${prompt.replace(/\W+/g, '-').slice(0, 80)}`;
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(true);
  });

  it('does not activate ralph for Korean banter/question wording from issue #3162', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-banter-'));
    const sessionId = 'session-3162-ralph-banter';
    const output = runKeywordDetector('너도 ralph라도 쥐어줘야해?ㅋㅋ', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(false);
  });

  it('does not activate ralph or ultrawork for Korean relationship meta-question from issue #3162', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ultrawork-meta-'));
    const sessionId = 'session-3162-ultrawork-meta';
    const output = runKeywordDetector('울트라워크랑 랄프는 무슨 관계야?', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const stateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(context).not.toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(existsSync(join(stateDir, 'ralph-state.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
  });

  it('still activates ralph and ultrawork for explicit imperative prompts from issue #3162', () => {
    const cases = [
      { prompt: '/ralph fix parser', mode: 'ralph' },
      { prompt: 'run ralph on this issue', mode: 'ralph' },
      { prompt: '랄프 켜', mode: 'ralph' },
      { prompt: 'start ultrawork on this issue', mode: 'ultrawork' },
      { prompt: '울트라워크 돌려', mode: 'ultrawork' },
    ] as const;

    for (const { prompt, mode } of cases) {
      const cwd = mkdtempSync(join(tmpdir(), `keyword-detector-${mode}-positive-`));
      const sessionId = `session-3162-${mode}-positive-${prompt.replace(/\W+/g, '-')}`;
      const output = runKeywordDetector(prompt, cwd, sessionId);
      const context = output.hookSpecificOutput?.additionalContext ?? '';

      expect(context).toContain(`[MAGIC KEYWORD: ${mode.toUpperCase()}]`);
      expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, `${mode}-state.json`))).toBe(true);
    }
  });

  it('only activates the explicitly commanded mode in mixed Korean meta-plus-imperative prompts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-mixed-intent-'));
    const sessionId = 'session-3162-mixed-intent';
    const output = runKeywordDetector('랄프랑 울트라워크는 무슨 관계야? 울트라워크 돌려', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const stateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);

    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(context).toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(existsSync(join(stateDir, 'ralph-state.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(true);
  });

  it('does not activate script-only uw alias for Korean banter/question wording', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-uw-banter-'));
    const sessionId = 'session-3162-uw-banter';
    const output = runKeywordDetector('너도 uw라도 쥐어줘야해?ㅋㅋ', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).not.toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json'))).toBe(false);
  });

  // Regression: "autonomous" appearing in technical / research prose must not
  // trigger autopilot (false positive previously created spurious
  // autopilot-state.json and a stop-hook loop). The TS source and the
  // templates/hooks mjs already exclude the word; this test guards the
  // deployed scripts/keyword-detector.mjs against drift.
  it('does not activate autopilot when "autonomous" appears in technical prose', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autonomous-'));
    const sessionId = 'session-autonomous-regression';
    const output = runKeywordDetector(
      'DriveVLA-W0: World Models Amplify Data Scaling Law in Autonomous Driving — please summarize this paper.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const autopilotStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(autopilotStatePath)).toBe(false);
  });

  it('still activates autopilot for an explicit autopilot invocation (positive control)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autopilot-positive-'));
    const sessionId = 'session-autopilot-positive';
    const output = runKeywordDetector('autopilot build a todo CLI', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const autopilotStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(autopilotStatePath)).toBe(true);
  });

  it.each([
    [
      'ทำไม autopilot มันชอบทำงานเองนะ',
      '[MAGIC KEYWORD: AUTOPILOT]',
      'autopilot-state.json',
    ],
    [
      'ผมอยากเพิ่ม rule ให้ถามกลับเหมือน skill deep interview แต่ระบบเดิมก็ทำได้อยู่แล้วถูกมั้ย',
      '[MAGIC KEYWORD: DEEP-INTERVIEW]',
      'deep-interview-state.json',
    ],
    [
      'autopilot คืออะไร ใช้งานยังไง',
      '[MAGIC KEYWORD: AUTOPILOT]',
      'autopilot-state.json',
    ],
  ] as const)('does not activate workflow for informational Thai prompt "%s"', (prompt, marker, stateFile) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-thai-info-'));
    const sessionId = 'session-thai-info';
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain(marker);
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, stateFile))).toBe(false);
  });

  it.each([
    'build me a website เหมือน Airbnb',
    'I want a dashboard เกี่ยวกับ sales',
  ])('activates autopilot for Thai-adjacent creation alias "%s"', (prompt) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autopilot-thai-creation-'));
    const sessionId = 'session-autopilot-thai-creation';
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(true);
  });

  it('does not activate autopilot for colon-prefixed heading help question', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autopilot-colon-help-'));
    const sessionId = 'session-autopilot-colon-help';
    const output = runKeywordDetector('autopilot: what is it and how do I use it?', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  it('does not activate autopilot for English help-style use questions in the script copy', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autopilot-help-question-'));
    const sessionId = 'session-autopilot-help-question';
    const output = runKeywordDetector('How do I use autopilot?', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  it.each([
    'autopilot: build me a todo app',
    'autopilot: ทำเว็บเหมือน Trello',
    'autopilot: แก้บั๊กเกี่ยวกับ auth',
  ])('still activates autopilot for colon-prefixed command "%s"', (prompt) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-autopilot-colon-positive-'));
    const sessionId = 'session-autopilot-colon-positive';
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(true);
  });

  // Regression (issue #3380): a keyword quoted inside reported/example text
  // (e.g. an example sentence like `"use autopilot"` embedded in prose
  // discussing that exact phrasing) must not activate. This guards the
  // deployed scripts/keyword-detector.mjs against drift from
  // src/hooks/keyword-detector/index.ts, since this exact false positive was
  // fixed in the TS source but initially missed in this standalone copy.
  it('does not activate autopilot for a keyword quoted inside reported speech', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-span-'));
    const sessionId = 'session-quoted-span-3380';
    const output = runKeywordDetector(
      'Your last message contained "I thought if I told it to use autopilot, it would just continue..." — that\'s reported speech about a hypothetical.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const autopilotStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(autopilotStatePath)).toBe(false);
  });

  it('still activates ralph when quoted for emphasis alongside an execution directive (issue #3380 regression guard)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-directive-'));
    const sessionId = 'session-quoted-directive-3380';
    const output = runKeywordDetector('"ralph" fix the auth bug', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });

  // Regression (issue #3380, QA round 2): the execution-directive check that
  // gates the quote exemption must be scoped to the specific quoted span, not
  // the generic ±80-char context window shared with unrelated keywords in the
  // same message — otherwise a genuine directive-bearing command elsewhere in
  // the message wrongly neutralizes the exemption for a keyword that is
  // purely quoted as an example.
  it('does not activate the quoted keyword when an unrelated genuine command appears elsewhere in the message', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-mixed-message-'));
    const sessionId = 'session-mixed-message-3380';
    const output = runKeywordDetector(
      'Docs say "use autopilot" as an example, but can you run ralph now to fix the deployment script?',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  // Regression (issue #3382): an informational/reference occurrence of a
  // keyword earlier in the same prompt must not suppress a later directive
  // occurrence of that same keyword.
  it('activates ralph for a later directive after an earlier informational mention', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-info-then-directive-'));
    const sessionId = 'session-info-then-directive-3382';
    const output = runKeywordDetector(
      'The old docs call ralph deprecated. Please ralph and fix the flaky tests.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });

  it('does not activate ralph for an informational mention followed by a quoted please phrase', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-please-ralph-'));
    const sessionId = 'session-quoted-please-ralph-3382';
    const output = runKeywordDetector(
      'The docs say ralph is triggered by the phrase "please ralph".',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(false);
  });

  it('does not activate autopilot for an informational mention followed by a quoted please phrase', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-please-autopilot-'));
    const sessionId = 'session-quoted-please-autopilot-3382';
    const output = runKeywordDetector(
      'The docs say autopilot is triggered by the phrase "please autopilot".',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  // Regression (issue #3380, repo-owner review bot finding against the round-1
  // fix commit): a bug-report/discussion prompt that describes fixing this
  // exact false positive, and happens to contain an execution-directive verb
  // near the quoted example, must not itself trigger the false positive it is
  // describing.
  it('does not activate autopilot when a bug-report prompt describes fixing the false positive itself', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-bugreport-fix-'));
    const sessionId = 'session-bugreport-fix-3380';
    const output = runKeywordDetector(
      'Please fix the detector: it activates when the user writes "use autopilot" in a bug report.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  it('does not activate autopilot when asked to implement a regression test for the quoted phrase', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-implement-test-'));
    const sessionId = 'session-implement-test-3380';
    const output = runKeywordDetector(
      'Implement a regression test for the sentence "use autopilot" so it no longer activates.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  it('does not activate ralph when asked to address a false positive describing the quoted phrase', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-address-fp-'));
    const sessionId = 'session-address-fp-3380';
    const output = runKeywordDetector(
      'Please address this false positive: "run ralph on this" should be treated as docs text.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(false);
  });

  // Regression (issue #3380, QA round 3): the execution-directive check must
  // NOT include the quoted text's own interior — only text immediately
  // outside the quote's boundaries. Otherwise a directive word used INSIDE a
  // narrated/reported quote (extremely common: "she said 'fix X'") makes the
  // quote self-report as directive-bearing and defeats the exemption for
  // exactly the reported-speech case issue #3380 exists to catch.
  it('does not activate autopilot when the execution directive is INSIDE the quoted text itself', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-inside-quote-directive-'));
    const sessionId = 'session-inside-quote-directive-3380';
    const output = runKeywordDetector(
      'The old ticket said "please fix autopilot" and closed without action.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  it('does not activate autopilot for a narrated quote containing a directive, while still detecting an unrelated genuine command', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-inside-quote-mixed-'));
    const sessionId = 'session-inside-quote-mixed-3380';
    const output = runKeywordDetector(
      'The FAQ says "please fix autopilot" is a common typo people made in 2023. Separately, ralph the test suite until it passes.',
      cwd,
      sessionId,
    );
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(false);
  });

  // Regression (issue #3380, repo-owner review bot finding against commit
  // 0d6cf924): the near-quote command check must also recognize activation
  // verbs (use/run/start/enable/activate/invoke/trigger/launch), not just
  // execution-directive verbs (fix/debug/...) — otherwise a genuine command
  // that quotes only the mode name for emphasis (e.g. `run "ralph" on this
  // issue`) is wrongly suppressed, even though it activated before the
  // quote-exemption existed.
  it('still activates ralph when the mode name alone is quoted for emphasis after an activation verb', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-activation-verb-ralph-'));
    const sessionId = 'session-quoted-activation-verb-ralph-3380';
    const output = runKeywordDetector('run "ralph" on this issue', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });

  it('still activates autopilot when the mode name alone is quoted for emphasis after an activation verb', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-activation-verb-autopilot-'));
    const sessionId = 'session-quoted-activation-verb-autopilot-3380';
    const output = runKeywordDetector('use "autopilot" on this task', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: AUTOPILOT]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'))).toBe(true);
  });

  it('still activates ultrawork when the mode name alone is quoted for emphasis after an activation verb', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-quoted-activation-verb-ultrawork-'));
    const sessionId = 'session-quoted-activation-verb-ultrawork-3380';
    const output = runKeywordDetector('start "ultrawork" on this repo', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json'))).toBe(true);
  });

  // Japanese full-width katakana variants must fire on the deployed runtime
  // hook (scripts/keyword-detector.mjs), not just the TS source. Mirrors the
  // existing Korean positive controls above and guards the standalone copy
  // against drift from src/hooks/keyword-detector/index.ts.
  it('activates ralph for "ラルフ 起動" katakana invocation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-katakana-'));
    const sessionId = 'session-katakana-ralph';
    const output = runKeywordDetector('ラルフ 起動', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });

  it('activates ultrawork for "ウルトラワークで並列実行して" katakana invocation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ultrawork-katakana-'));
    const sessionId = 'session-katakana-ultrawork';
    const output = runKeywordDetector('ウルトラワークで並列実行して', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: ULTRAWORK]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json'))).toBe(true);
  });

  it('activates ralplan for bare "ラルプラン" katakana invocation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralplan-katakana-'));
    const sessionId = 'session-katakana-ralplan';
    const output = runKeywordDetector('ラルプラン', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');
    expect(existsSync(getRalplanStatePath(cwd, sessionId))).toBe(true);
  });

  it('does not activate ralph for "ラルフローレンのシャツ" (Ralph Lauren exclusion)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-lauren-'));
    const sessionId = 'session-katakana-ralph-lauren';
    const output = runKeywordDetector('ラルフローレンのシャツ', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(false);
  });

  it('does not activate ralph for Japanese complaint "ラルフ、また失敗した"', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-jp-complaint-'));
    const sessionId = 'session-katakana-ralph-complaint';
    const output = runKeywordDetector('ラルフ、また失敗した', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(false);
  });

  it.each([
    ['ウルトラワークについて教えて', '[MAGIC KEYWORD: ULTRAWORK]', 'ultrawork-state.json'],
    ['オートパイロットについて教えて', '[MAGIC KEYWORD: AUTOPILOT]', 'autopilot-state.json'],
    ['ラルフについて教えて', '[MAGIC KEYWORD: RALPH]', 'ralph-state.json'],
  ] as const)('does not activate workflow for informational Japanese prompt "%s"', (prompt, marker, stateFile) => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-jp-info-'));
    const sessionId = 'session-jp-info';
    const output = runKeywordDetector(prompt, cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain(marker);
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, stateFile))).toBe(false);
  });

  it('activates ralph for Japanese execution request that asks for the result', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-jp-ralph-exec-'));
    const sessionId = 'session-jp-ralph-exec';
    const output = runKeywordDetector('ラルフを実行して結果を教えて', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });

  it('does not activate ralph for a leading proper-noun mention ("Ralph Step 0a wiring")', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-proper-noun-'));
    const sessionId = 'session-ralph-proper-noun';
    const output = runKeywordDetector('Ralph Step 0a wiring is advisory, not a hook.', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(false);
  });

  it('does not activate ralph for a hyphenated identifier mention ("wire ralph-step-0a.sh")', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-hyphen-'));
    const sessionId = 'session-ralph-hyphen';
    const output = runKeywordDetector('wire ralph-step-0a.sh into its callers', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(false);
  });

  it('does not activate ralph for a hyphenated state filename mention ("ralph-state.json")', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-state-file-'));
    const sessionId = 'session-ralph-state-file';
    const output = runKeywordDetector('inspect ralph-state.json without starting the hook', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    const ralphStatePath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(ralphStatePath)).toBe(false);
  });

  it('still activates ralph for a leading imperative task ("ralph fix the tests")', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-ralph-leading-imperative-'));
    const sessionId = 'session-ralph-leading-imperative';
    const output = runKeywordDetector('ralph fix the tests', cwd, sessionId);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'))).toBe(true);
  });
});

describe('keyword-detector.mjs keywordDetector.disabled opt-out', () => {
  function makeCwdWithDisabled(disabled: string[]) {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-disabled-'));
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    // Canonical JSONC shape: a comment and trailing commas, which parseJsonc supports.
    const list = disabled.map((name) => `"${name}",`).join(' ');
    writeFileSync(
      join(cwd, '.claude', 'omc.jsonc'),
      `{\n  // keyword-detector opt-out\n  "keywordDetector": { "disabled": [${list}] },\n}`,
    );
    return cwd;
  }

  it('activates wiki with no opt-out config (positive control)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-wiki-default-'));
    const output = runKeywordDetector('wiki this auth finding', cwd);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: WIKI]');
  });

  it('does not activate wiki when it is in keywordDetector.disabled', () => {
    const cwd = makeCwdWithDisabled(['wiki']);
    const output = runKeywordDetector('wiki this auth finding', cwd);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: WIKI]');
  });

  it('only disables the listed keyword, leaving others active', () => {
    const cwd = makeCwdWithDisabled(['wiki']);
    const output = runKeywordDetector('deepsearch the codebase for keyword dispatch', cwd);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('<search-mode>');
  });

  it('never disables cancel even when listed (emergency stop protection)', () => {
    const cwd = makeCwdWithDisabled(['cancel']);
    const output = runKeywordDetector('cancelomc', cwd);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: CANCEL]');
  });
});

describe('keyword-detector.mjs global disable values', () => {
  it.each(['1', 'true'])('short-circuits only for DISABLE_OMC=%s', (value) => {
    const output = runKeywordDetector('deepsearch this codebase', process.cwd(), 'keyword-disable', {
      DISABLE_OMC: value,
    });

    expect(output).toEqual({ continue: true });
  });

  it.each(['', '0', 'false', 'TRUE', 'yes'])('does not treat DISABLE_OMC=%s as a global disable', (value) => {
    const output = runKeywordDetector('deepsearch this codebase', process.cwd(), 'keyword-not-disabled', {
      DISABLE_OMC: value,
    });

    expect(output.hookSpecificOutput?.additionalContext).toContain('<search-mode>');
  });
});
