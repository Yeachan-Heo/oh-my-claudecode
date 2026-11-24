import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CliAgentType } from '../model-contract.js';
import { classifyPane, observePane, type PaneState } from '../pane-readiness.js';
import {
  detectPaneTrustPromptKind,
  paneHasActiveTask,
  paneLooksReady,
  type PaneTrustPromptKind,
} from '../tmux-session.js';

// Pins what the pane classifiers answer today for every frame in the corpus,
// wrong answers included, so later readiness PRs show each behavior change as
// a diff to this table. Add a fixture with scripts/record-pane-frames.mjs.

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');

interface ManifestEntry {
  file: string;
  provider: CliAgentType;
  version: string;
  state: string;
  cols: number | null;
  rows: number | null;
  launch_args: string[] | null;
  source: 'recorded' | 'migrated' | 'synthetic';
  origin: string;
  hooks?: boolean;
  note?: string;
}

interface Outputs {
  ready: boolean;
  busy: boolean;
  trust: PaneTrustPromptKind | null;
}

// What classifyPane reads for the idle nudge and the monitor, which pass no provider.
type StateName = PaneState['kind'] extends infer K ? K extends 'trust' ? `trust:${PaneTrustPromptKind}` : K : never;

type Row = Outputs &
  ({ known_wrong?: undefined } | { known_wrong: true; reason: string }) &
  { state: StateName; state_wrong?: string };

const TRUST_READY = 'a trust prompt is reported ready';
const TRUST_MID_DRAW = 'the trust dialog caught while Claude Code draws it (about 4 ms): its focused "❯ No, exit" line reads as an idle prompt and the trust detector does not read it yet';
const BUSY_READY = 'ready and busy at once: the input box stays drawn while the provider works';
const SHELL_IDLE = 'the provider has exited and its shell prompt reads as idle; the nudge and the monitor rule it out only when provider liveness confirms the exit';
const CURSOR_UNREAD = 'without the provider, Cursor\'s → prompt and stop hint are not read; no Cursor frame has been recorded';

const TABLE: Readonly<Record<string, Row>> = {
  'claude/2.1.142/idle-bypass.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.142/idle-gutter.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.310/trust-35col.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/2.1.310/trust-59col-partial.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/2.1.310/trust-59col.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/2.1.325/busy-after-blocked-stop.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-blocked-stop-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-posttooluse-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-spinner.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-stop-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-tokens.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/busy-userpromptsubmit-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/2.1.325/done-after-blocked-stop.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/done.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/idle-first-paint.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/idle-hud.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/idle-mode-footer.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/idle-sessionstart-hook-error.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/idle.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.325/trust-just-answered.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/2.1.325/trust.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  // Claude Code's first-run dialogs are read only by the startup wait (detectClaudeStartupDialog).
  'claude/2.1.328/bypass-permissions-yes-focused.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.328/bypass-permissions.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.328/fullscreen-renderer-not-now-focused.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.328/fullscreen-renderer.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.328/idle-after-fullscreen-renderer.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.328/trust-yes-focused.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  // Claude Code's onboarding is read only by the startup wait (detectClaudeStartupDialog).
  'claude/2.1.329/onboarding-security-notes.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/2.1.329/onboarding-theme.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.330/bypass-permissions-body-partial.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/2.1.330/bypass-permissions-no-choices.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/2.1.330/bypass-permissions.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/2.1.330/trust-body-partial.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/2.1.330/trust-no-choice-partial.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: TRUST_MID_DRAW, state: 'idle', state_wrong: TRUST_MID_DRAW },
  'claude/2.1.330/trust-yes-choice-partial.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: TRUST_MID_DRAW, state: 'idle', state_wrong: TRUST_MID_DRAW },
  'claude/2.1.330/trust.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/2.1.330/trust-yes-focused.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/synthetic/loading-in-scrollback.txt': { ready: false, busy: false, trust: null, known_wrong: true, reason: '"loading" anywhere in scrollback reads as bootstrapping, so an idle pane is never ready', state: 'idle' },
  'claude/synthetic/output-quoting-first-run-dialogs.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/synthetic/prompt-glyph-in-output.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'a quoted "> " line in model output reads as an idle prompt before any input box exists', state: 'idle', state_wrong: 'a quoted "> " line in model output reads as an idle prompt' },
  'claude/synthetic/shell-prompt-after-exit-dollar.txt': { ready: false, busy: false, trust: null, state: 'unknown' },
  'claude/synthetic/shell-prompt-after-exit-heavy-angle.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using ❯ reads as an idle provider prompt', state: 'idle', state_wrong: SHELL_IDLE },
  'claude/unversioned/busy-compacting-suffix.txt': { ready: false, busy: true, trust: null, state: 'busy' },
  'claude/unversioned/busy-thinking-after-trigger.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/unversioned/busy-thinking-esc.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'claude/unversioned/idle-below-bypass-banner.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/unversioned/idle-welcome-greater-than.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/unversioned/idle-welcome.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/unversioned/output-quoting-trust-choices.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/unversioned/startup-banner-bypass.txt': { ready: false, busy: false, trust: null, state: 'bootstrapping' },
  'claude/unversioned/startup-trigger-pending.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'claude/unversioned/trust-files-question.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/unversioned/trust-files-then-idle.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: 'trust is still reported after the dialog was answered and an idle prompt is drawn', state: 'trust:claude_directory', state_wrong: 'an answered dialog left above the prompt still reads as trust; Claude 2.1.325 clears it once answered' },
  'claude/unversioned/trust-files-wrapped.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/unversioned/trust-quick-safety-check.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY, state: 'trust:claude_directory' },
  'claude/unversioned/unrelated-input.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/busy.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'codex/0.167.0/done-reconnecting.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/done.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/idle-before-trust.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'codex draws its idle prompt about 0.25s before the folder-trust dialog replaces it', state: 'idle', state_wrong: 'codex draws its idle prompt about 0.25s before the folder-trust dialog replaces it' },
  'codex/0.167.0/idle.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/prompt-typed-unsubmitted.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/startup-loading.txt': { ready: false, busy: false, trust: null, state: 'bootstrapping' },
  'codex/0.167.0/trust-just-answered.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/0.167.0/trust.txt': { ready: false, busy: false, trust: 'codex_directory', state: 'trust:codex_directory' },
  'codex/synthetic/shell-prompt-after-exit-single-angle.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using › reads as an idle provider prompt', state: 'idle', state_wrong: SHELL_IDLE },
  'codex/unversioned/busy-esc.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'busy' },
  'codex/unversioned/hooks-review-short.txt': { ready: true, busy: false, trust: 'codex_hooks', known_wrong: true, reason: TRUST_READY, state: 'trust:codex_hooks' },
  'codex/unversioned/hooks-review.txt': { ready: true, busy: false, trust: 'codex_hooks', known_wrong: true, reason: TRUST_READY, state: 'trust:codex_hooks' },
  'codex/unversioned/idle-ready.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/unversioned/trust-directory-legacy.txt': { ready: true, busy: false, trust: 'directory', known_wrong: true, reason: TRUST_READY, state: 'trust:directory' },
  'codex/unversioned/trust-directory-with-interrupt-text.txt': { ready: true, busy: true, trust: 'directory', known_wrong: true, reason: TRUST_READY, state: 'trust:directory' },
  'codex/unversioned/trust-folder-answered.txt': { ready: true, busy: false, trust: null, state: 'idle' },
  'codex/unversioned/trust-folder-partial.txt': { ready: false, busy: false, trust: 'codex_directory', state: 'trust:codex_directory' },
  'codex/unversioned/trust-folder-windows.txt': { ready: false, busy: false, trust: 'codex_directory', state: 'trust:codex_directory' },
  'codex/unversioned/trust-folder.txt': { ready: false, busy: false, trust: 'codex_directory', state: 'trust:codex_directory' },
  'cursor/synthetic/shell-prompt-after-exit-greater-than.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using > reads as an idle provider prompt', state: 'idle', state_wrong: SHELL_IDLE },
  'cursor/unversioned/busy-ctrl-c.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY, state: 'unknown', state_wrong: CURSOR_UNREAD },
  'cursor/unversioned/idle-arrow.txt': { ready: true, busy: false, trust: null, state: 'unknown', state_wrong: CURSOR_UNREAD },
  'cursor/unversioned/workspace-trust-short.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust', state: 'trust:cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust-with-choices-and-hint.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust', state: 'trust:cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust-with-directory-choices.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust', state: 'trust:cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust', state: 'trust:cursor_workspace_trust' },
};

const manifest = JSON.parse(readFileSync(join(CORPUS_ROOT, 'manifest.json'), 'utf8')) as ManifestEntry[];

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fixtureFiles(path);
    return entry.name.endsWith('.txt') ? [relative(CORPUS_ROOT, path).split(sep).join('/')] : [];
  });
}

describe('pane frame corpus', () => {
  it('has one manifest entry per fixture file, filed under its provider and version', () => {
    const files = fixtureFiles(CORPUS_ROOT).sort();
    expect(manifest.map(entry => entry.file).sort()).toEqual(files);
    for (const entry of manifest) {
      expect(entry.file).toBe(`${entry.provider}/${entry.version}/${entry.state}.txt`);
    }
  });

  it('has one characterization row per fixture file', () => {
    expect(Object.keys(TABLE).sort()).toEqual(fixtureFiles(CORPUS_ROOT).sort());
  });

  it('pins the measured Claude trust frame and the ❯ shell prompt as known wrong', () => {
    expect(TABLE['claude/2.1.325/trust.txt']).toMatchObject({ ready: true, trust: 'claude_directory', known_wrong: true });
    expect(TABLE['claude/synthetic/shell-prompt-after-exit-heavy-angle.txt']).toMatchObject({ ready: true, known_wrong: true });
  });
});

describe('pane classifiers on the frame corpus (characterization)', () => {
  it.each(manifest.map(entry => [entry.file, entry] as const))('%s', (file, entry) => {
    const captured = readFileSync(join(CORPUS_ROOT, file), 'utf8');
    const row = TABLE[file];
    expect(row, `no characterization row for ${file}`).toBeDefined();
    const actual: Outputs = {
      ready: paneLooksReady(captured, entry.provider),
      busy: paneHasActiveTask(captured, entry.provider),
      trust: detectPaneTrustPromptKind(captured, entry.provider),
    };
    expect(actual).toEqual({ ready: row!.ready, busy: row!.busy, trust: row!.trust });
  });
});

describe('the decision state on the frame corpus (characterization)', () => {
  it.each(manifest.map(entry => entry.file))('%s', (file) => {
    const state = classifyPane(observePane(readFileSync(join(CORPUS_ROOT, file), 'utf8')));
    const name = state.kind === 'trust' ? `trust:${state.trust}` : state.kind;
    expect(name).toBe(TABLE[file]!.state);
  });

  it('reads three recorded frames wrongly: the Codex prompt drawn just before its trust dialog, and the Claude trust dialog caught mid-draw', () => {
    const wrongRecorded = manifest
      .filter(entry => entry.source === 'recorded' && TABLE[entry.file]!.state_wrong !== undefined)
      .map(entry => entry.file);
    expect(wrongRecorded).toEqual([
      'claude/2.1.330/trust-no-choice-partial.txt',
      'claude/2.1.330/trust-yes-choice-partial.txt',
      'codex/0.167.0/idle-before-trust.txt',
    ]);
  });
});
