import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;

function runKeywordDetector(prompt: string, cwd = process.cwd(), sessionId = 'session-2053') {
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

  it('still emits magic keyword invocation for true skills like ralplan', () => {
    const output = runKeywordDetector('ralplan fix issue #2053');
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');
    expect(context).toContain('name: ralplan');
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
});
