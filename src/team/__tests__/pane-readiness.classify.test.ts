import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CliAgentType } from '../model-contract.js';
import {
  claudeDialogFocus,
  classifyPane,
  detectClaudeStartupDialog,
  detectPaneTrustPromptKind,
  observePane,
  PANE_PATTERNS,
  paneHasActiveTask,
  paneLooksReady,
  type PaneSignals,
} from '../pane-readiness.js';

// Pins the independent signals observePane reads from every frame in the
// corpus. Each row lists the signals that are set, so a blank row is a frame
// that shows none of them.

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');

interface ManifestEntry {
  file: string;
  provider: CliAgentType;
  version: string;
  source: 'recorded' | 'migrated' | 'synthetic';
}

const manifest = JSON.parse(readFileSync(join(CORPUS_ROOT, 'manifest.json'), 'utf8')) as ManifestEntry[];

function describeSignals(signals: PaneSignals): string {
  return [
    signals.trust ? `trust:${signals.trust}` : '',
    signals.bootstrapping ? 'bootstrapping' : '',
    signals.startupStatus ? 'startupStatus' : '',
    signals.idlePrompt ? 'idlePrompt' : '',
    signals.busy ? 'busy' : '',
  ].filter(Boolean).join(' ');
}

const SIGNALS: Readonly<Record<string, string>> = {
  'claude/2.1.142/idle-bypass.txt': 'idlePrompt',
  'claude/2.1.142/idle-gutter.txt': 'idlePrompt',
  'claude/2.1.310/trust-35col.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.310/trust-59col-partial.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.310/trust-59col.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.325/busy-after-blocked-stop.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-blocked-stop-hook.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-posttooluse-hook.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-spinner.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-stop-hook.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-tokens.txt': 'idlePrompt busy',
  'claude/2.1.325/busy-userpromptsubmit-hook.txt': 'idlePrompt busy',
  'claude/2.1.325/done-after-blocked-stop.txt': 'idlePrompt',
  'claude/2.1.325/done.txt': 'idlePrompt',
  'claude/2.1.325/idle-first-paint.txt': 'idlePrompt',
  'claude/2.1.325/idle-hud.txt': 'idlePrompt',
  'claude/2.1.325/idle-mode-footer.txt': 'idlePrompt',
  'claude/2.1.325/idle-sessionstart-hook-error.txt': 'idlePrompt',
  'claude/2.1.325/idle.txt': 'idlePrompt',
  'claude/2.1.325/trust-just-answered.txt': '',
  'claude/2.1.325/trust.txt': 'trust:claude_directory idlePrompt',
  // Claude Code's first-run dialogs are read only by the startup wait (detectClaudeStartupDialog).
  'claude/2.1.328/bypass-permissions-yes-focused.txt': 'idlePrompt',
  'claude/2.1.328/bypass-permissions.txt': 'idlePrompt',
  'claude/2.1.328/fullscreen-renderer-not-now-focused.txt': 'idlePrompt',
  'claude/2.1.328/fullscreen-renderer.txt': 'idlePrompt',
  'claude/2.1.328/idle-after-fullscreen-renderer.txt': 'idlePrompt',
  'claude/2.1.328/trust-yes-focused.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.329/onboarding-security-notes.txt': '',
  'claude/2.1.329/onboarding-theme.txt': 'idlePrompt',
  'claude/2.1.330/bypass-permissions-body-partial.txt': '',
  'claude/2.1.330/bypass-permissions-no-choices.txt': '',
  'claude/2.1.330/bypass-permissions.txt': 'idlePrompt',
  'claude/2.1.330/trust-60col.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.330/trust-80col.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.330/trust-body-partial.txt': '',
  'claude/2.1.330/trust-no-choice-partial.txt': 'idlePrompt',
  'claude/2.1.330/trust-yes-choice-partial.txt': 'idlePrompt',
  'claude/2.1.330/trust.txt': 'trust:claude_directory idlePrompt',
  'claude/2.1.330/trust-yes-focused.txt': 'trust:claude_directory idlePrompt',
  'claude/synthetic/loading-in-scrollback.txt': 'bootstrapping idlePrompt',
  'claude/synthetic/output-quoting-first-run-dialogs.txt': 'idlePrompt',
  'claude/synthetic/prompt-glyph-in-output.txt': 'idlePrompt',
  'claude/synthetic/shell-prompt-after-exit-dollar.txt': '',
  'claude/synthetic/shell-prompt-after-exit-heavy-angle.txt': 'idlePrompt',
  'claude/unversioned/busy-compacting-suffix.txt': 'busy',
  'claude/unversioned/busy-thinking-after-trigger.txt': 'idlePrompt busy',
  'claude/unversioned/busy-thinking-esc.txt': 'idlePrompt busy',
  'claude/unversioned/idle-below-bypass-banner.txt': 'idlePrompt',
  'claude/unversioned/idle-welcome-greater-than.txt': 'idlePrompt',
  'claude/unversioned/idle-welcome.txt': 'idlePrompt',
  'claude/unversioned/output-quoting-trust-choices.txt': 'idlePrompt',
  'claude/unversioned/startup-banner-bypass.txt': 'bootstrapping startupStatus',
  'claude/unversioned/startup-trigger-pending.txt': 'idlePrompt',
  'claude/unversioned/trust-files-question.txt': 'trust:claude_directory idlePrompt',
  'claude/unversioned/trust-files-then-idle.txt': 'trust:claude_directory idlePrompt',
  'claude/unversioned/trust-files-wrapped.txt': 'trust:claude_directory idlePrompt',
  'claude/unversioned/trust-quick-safety-check.txt': 'trust:claude_directory idlePrompt',
  'claude/unversioned/unrelated-input.txt': 'idlePrompt',
  'codex/0.167.0/busy.txt': 'idlePrompt busy',
  'codex/0.167.0/done-reconnecting.txt': 'idlePrompt',
  'codex/0.167.0/done.txt': 'idlePrompt',
  'codex/0.167.0/idle-before-trust.txt': 'idlePrompt',
  'codex/0.167.0/idle.txt': 'idlePrompt',
  'codex/0.167.0/prompt-typed-unsubmitted.txt': 'idlePrompt',
  'codex/0.167.0/startup-loading.txt': 'bootstrapping startupStatus idlePrompt',
  'codex/0.167.0/trust-just-answered.txt': 'idlePrompt',
  'codex/0.167.0/trust.txt': 'trust:codex_directory idlePrompt',
  'codex/synthetic/shell-prompt-after-exit-single-angle.txt': 'idlePrompt',
  'codex/unversioned/busy-esc.txt': 'idlePrompt busy',
  'codex/unversioned/hooks-review-short.txt': 'trust:codex_hooks idlePrompt',
  'codex/unversioned/hooks-review.txt': 'trust:codex_hooks idlePrompt',
  'codex/unversioned/idle-ready.txt': 'idlePrompt',
  'codex/unversioned/trust-directory-legacy.txt': 'trust:directory idlePrompt',
  'codex/unversioned/trust-directory-with-interrupt-text.txt': 'trust:directory idlePrompt busy',
  'codex/unversioned/trust-folder-answered.txt': 'idlePrompt',
  'codex/unversioned/trust-folder-partial.txt': 'trust:codex_directory idlePrompt',
  'codex/unversioned/trust-folder-windows.txt': 'trust:codex_directory idlePrompt',
  'codex/unversioned/trust-folder.txt': 'trust:codex_directory idlePrompt',
  'cursor/synthetic/shell-prompt-after-exit-greater-than.txt': 'idlePrompt',
  'cursor/unversioned/busy-ctrl-c.txt': 'idlePrompt busy',
  'cursor/unversioned/idle-arrow.txt': 'idlePrompt',
  'cursor/unversioned/workspace-trust-short.txt': 'trust:cursor_workspace_trust',
  'cursor/unversioned/workspace-trust-with-choices-and-hint.txt': 'trust:cursor_workspace_trust idlePrompt',
  'cursor/unversioned/workspace-trust-with-directory-choices.txt': 'trust:cursor_workspace_trust idlePrompt',
  'cursor/unversioned/workspace-trust.txt': 'trust:cursor_workspace_trust',
};

function frame(file: string): string {
  return readFileSync(join(CORPUS_ROOT, file), 'utf8');
}

describe('observePane on the frame corpus', () => {
  it('has one signal row per manifest entry', () => {
    expect(Object.keys(SIGNALS).sort()).toEqual(manifest.map(entry => entry.file).sort());
  });

  it.each(manifest.map(entry => [entry.file, entry.provider] as const))('%s', (file, provider) => {
    expect(describeSignals(observePane(frame(file), provider))).toBe(SIGNALS[file]);
  });

  it('reports the idle prompt and the busy marker together while Claude works', () => {
    expect(observePane(frame('claude/2.1.325/busy-spinner.txt'), 'claude')).toEqual({
      trust: null, bootstrapping: false, startupStatus: false, idlePrompt: true, busy: true,
    });
  });

  it('reports nothing for a blank capture', () => {
    expect(observePane('', 'claude')).toEqual({ trust: null, bootstrapping: false, startupStatus: false, idlePrompt: false, busy: false });
    expect(observePane(' \r\n\n', undefined)).toEqual({ trust: null, bootstrapping: false, startupStatus: false, idlePrompt: false, busy: false });
  });

  it('accepts another provider\'s trust dialog only when the provider is unknown', () => {
    const codexTrust = frame('codex/unversioned/trust-folder.txt');
    expect(observePane(codexTrust, undefined).trust).toBe('codex_directory');
    expect(observePane(codexTrust, 'codex').trust).toBe('codex_directory');
    expect(observePane(codexTrust, 'claude').trust).toBeNull();
  });

  it('counts ctrl+c to stop as busy for cursor only', () => {
    const cursorBusy = frame('cursor/unversioned/busy-ctrl-c.txt');
    expect(observePane(cursorBusy, 'cursor').busy).toBe(true);
    expect(observePane(cursorBusy, 'claude').busy).toBe(false);
  });
});

describe('a provider name outside the table', () => {
  // Team state is read back with casts such as `worker.provider as CliAgentType`.
  const stored = (name: string) => name as CliAgentType;

  it.each(['other', 'constructor', 'CLAUDE', ''])('reads %j with the shared patterns instead of throwing', (name) => {
    const provider = stored(name);
    expect(paneLooksReady('Some output\n❯ ', provider)).toBe(true);
    expect(paneHasActiveTask('· Thinking…\n❯ ', provider)).toBe(true);
    expect(detectPaneTrustPromptKind(frame('claude/2.1.325/trust.txt'), provider)).toBeNull();
    expect(detectPaneTrustPromptKind('Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit', provider)).toBe('directory');
    expect(observePane('→ ready', provider).idlePrompt).toBe(false);
  });
});

describe('classifyPane', () => {
  const all = { trust: 'claude_directory', bootstrapping: true, startupStatus: true, idlePrompt: true, busy: true } as const;
  const none = { trust: null, bootstrapping: false, startupStatus: false, idlePrompt: false, busy: false } as const;

  it('puts a pane in exactly one state, in the order trust, busy, bootstrapping, idle', () => {
    expect(classifyPane(all)).toEqual({ kind: 'trust', trust: 'claude_directory' });
    expect(classifyPane({ ...all, trust: null })).toEqual({ kind: 'busy' });
    expect(classifyPane({ ...all, trust: null, busy: false })).toEqual({ kind: 'bootstrapping' });
    expect(classifyPane({ ...none, idlePrompt: true })).toEqual({ kind: 'idle' });
    expect(classifyPane(none)).toEqual({ kind: 'unknown' });
  });

  it('reads a startup word as starting only on a status line', () => {
    const state = (capture: string) => classifyPane(observePane(capture)).kind;
    expect(state('model: loading\ngpt-5.3-codex high · 80% left\n› ')).toBe('bootstrapping');
    expect(state('⠋ Initializing…\n❯ ')).toBe('bootstrapping');
    expect(state('│ ⠋ Initializing… │\n│ > Type your message │')).toBe('bootstrapping');
    expect(state('⠋ Connecting to https://models.example.test/v1/sessions/worker-12345\n› ')).toBe('bootstrapping');
    expect(state(`loading ${'x'.repeat(39)}\n❯ `)).toBe('bootstrapping');
    expect(state(`loading ${'x'.repeat(40)}\n❯ `)).toBe('idle');
    for (const gemini of [
      '⠋ Resuming session... (Connecting to MCP servers... (1/3))',
      '⠋ Resuming session...',
      'Resuming session...',
      'Resuming session... (Connecting to MCP servers... (0/1))',
      'Connecting to MCP servers... (0/3) - Waiting for: playwright, filesystem, github',
    ]) {
      expect(state(`${gemini}\n> earlier request`)).toBe('bootstrapping');
    }
    expect(state('⏺ It said:\nResuming session... worked after the restart.\n❯ ')).toBe('idle');
    expect(state('⠋ Resuming session... (Connecting\nto MCP servers... (1/3))\n> earlier request')).toBe('bootstrapping');
    expect(state('⏺ Found it.\nConnecting to MCP servers... (0/3) was the last line before the fix.\n❯ ')).toBe('idle');
    expect(state(`│ model: loading${' '.repeat(60)}│\n› Ask Codex to do anything`)).toBe('bootstrapping');
    expect(state('⣾ Loading model weights from the local cache\n❯ ')).toBe('bootstrapping');
    for (const quoted of ['  "loadingState": "idle",', '  "loading": false,', "  'connecting to the db' was the cause", '# Loading the config', '[loading] done']) {
      expect(state(`⏺ Changes verified\n${quoted}\n❯ `)).toBe('idle');
    }
    for (const listed of ['  - Resuming session after a disconnect now preserves the draft.', '* Loading the config was slow.', '+ Initializing the cache is done.']) {
      expect(state(`⏺ Changes verified\n${listed}\n❯ `)).toBe('idle');
    }
    for (const history of ['❯ Loading the config fails. Diagnose it.', '› Loading the config fails.', '> loading', '→ loading']) {
      expect(state(`${history}\n⏺ Done.\n❯ `)).toBe('idle');
    }
    for (const reply of ['⏺ Loading the fixtures took 2s.', '• Starting up the dev server worked.', '✦ Connecting to MCP servers was slow today.', 'The page kept loading forever.']) {
      expect(state(`${reply}\n❯ `)).toBe('idle');
    }
  });

  it('keeps the startup word anywhere on screen in the signal read before sending keys', () => {
    expect(observePane('⏺ Fixed the lazy loading regression.\n❯ ').bootstrapping).toBe(true);
    expect(paneLooksReady('⏺ Fixed the lazy loading regression.\n❯ ')).toBe(false);
  });
});

describe('PANE_PATTERNS', () => {
  it('names a verified version only where the corpus holds recorded frames of it', () => {
    for (const [provider, patterns] of Object.entries(PANE_PATTERNS)) {
      const recorded = new Set(
        manifest.filter(entry => entry.provider === provider && entry.source === 'recorded').map(entry => entry.version),
      );
      if (patterns.verifiedVersion === null) expect([...recorded], provider).toEqual([]);
      else expect(recorded.has(patterns.verifiedVersion), provider).toBe(true);
    }
  });
});

describe('claudeDialogFocus', () => {
  const read = (file: string) => readFileSync(join(CORPUS_ROOT, file), 'utf8');
  const STALE_YES = ' ❯ Yes, I trust this folder\n';
  const trust = read('claude/2.1.325/trust.txt');
  const midDraw = trust.slice(0, trust.indexOf('Security guide') + 'Security guide'.length);

  it.each([
    ['claude/2.1.328/trust-yes-focused.txt', 'second'],
    ['claude/2.1.325/trust.txt', 'first'],
    ['claude/2.1.310/trust-35col.txt', 'first'],
    ['claude/unversioned/trust-files-wrapped.txt', 'first'],
  ] as const)('%s -> %s', (file, focus) => {
    expect(claudeDialogFocus(read(file), 'claude_directory')).toBe(focus);
  });

  it('reads the 35-column dialog once Down moved its focus', () => {
    const moved = read('claude/2.1.310/trust-35col.txt')
      .replace(' ❯ No, exit', '   No, exit')
      .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
    expect(claudeDialogFocus(moved, 'claude_directory')).toBe('second');
  });

  it('ignores a stale focused Yes in the scrollback above a live dialog focused on No', () => {
    expect(claudeDialogFocus(`${STALE_YES}${trust}`, 'claude_directory')).toBe('first');
  });

  it('reads an answered dialog with the input prompt drawn below its choices as stale', () => {
    expect(claudeDialogFocus(read('claude/unversioned/trust-files-then-idle.txt'), 'claude_directory')).toBe('stale');
  });

  it('reads no focus while a new dialog below an answered one has not drawn its choices', () => {
    expect(claudeDialogFocus(midDraw, 'claude_directory')).toBeNull();
    expect(claudeDialogFocus(`${read('claude/2.1.328/trust-yes-focused.txt')}\n${midDraw}`, 'claude_directory')).toBeNull();
  });
});

describe('Claude Code first-run dialogs', () => {
  const read = (file: string) => readFileSync(join(CORPUS_ROOT, file), 'utf8');
  // tmux hard-wraps a frame drawn wider than the pane.
  const hardWrap = (text: string, cols: number) =>
    text.split('\n').flatMap(line => line.match(new RegExp(`.{1,${cols}}`, 'gu')) ?? ['']).join('\n');
  const DIALOGS = [
    ['claude/2.1.328/bypass-permissions.txt', 'claude_bypass_permissions', 'first'],
    ['claude/2.1.328/bypass-permissions-yes-focused.txt', 'claude_bypass_permissions', 'second'],
    ['claude/2.1.328/fullscreen-renderer.txt', 'claude_fullscreen_renderer', 'first'],
    ['claude/2.1.328/fullscreen-renderer-not-now-focused.txt', 'claude_fullscreen_renderer', 'second'],
  ] as const;

  it.each(DIALOGS)('%s is %s with the %s choice focused', (file, kind, focus) => {
    expect(detectClaudeStartupDialog(read(file))).toBe(kind);
    expect(claudeDialogFocus(read(file), kind)).toBe(focus);
  });

  it.each(DIALOGS.flatMap(([file, kind]) => [18, 39].map(cols => [file, cols, kind] as const)))(
    '%s wrapped to %i columns is still %s', (file, cols, kind) => {
      expect(detectClaudeStartupDialog(hardWrap(read(file), cols))).toBe(kind);
    },
  );

  // Each copy of a dialog starts at its heading. Its choices, footer and ❯ are
  // read below the latest heading only, never from an older copy above it.
  it('reads no renderer focus while the latest copy, below an old one focused on Not now, has drawn no ❯ of its own', () => {
    const notNow = read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt');
    const offer = read('claude/2.1.328/fullscreen-renderer.txt');
    const upToYe = offer.slice(0, offer.indexOf('❯ 1. Yes') + '❯ 1. Ye'.length);
    expect(claudeDialogFocus(`${notNow}\n${upToYe}\n`, 'claude_fullscreen_renderer')).not.toBe('second');
    expect(claudeDialogFocus(`${notNow}\n${offer.replace('❯ 1. Yes, try it', '  1. Yes, try it')}`, 'claude_fullscreen_renderer')).toBeNull();
  });

  it('reads no renderer focus while the latest copy, below an old one, has drawn its ❯ but not its footer', () => {
    const notNow = read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt');
    const offer = read('claude/2.1.328/fullscreen-renderer.txt');
    const upToChoices = offer.slice(0, offer.indexOf('2. Not now') + '2. Not now'.length);
    expect(claudeDialogFocus(`${notNow}\n${upToChoices}\n`, 'claude_fullscreen_renderer')).toBeNull();
  });

  it('reads the renderer focus with the heading scrolled off a short pane', () => {
    const offer = read('claude/2.1.328/fullscreen-renderer.txt');
    const bottom = offer.slice(offer.indexOf('  ❯ 1. Yes, try it'));
    expect(claudeDialogFocus(bottom, 'claude_fullscreen_renderer')).toBe('first');
  });

  it('reads no bypass focus while the latest copy, below an old one focused on Yes, I accept, has drawn no ❯ of its own', () => {
    const accepted = read('claude/2.1.328/bypass-permissions-yes-focused.txt');
    const warning = read('claude/2.1.328/bypass-permissions.txt').replace('❯ No, exit', '  No, exit');
    expect(claudeDialogFocus(`${accepted}\n${warning}`, 'claude_bypass_permissions')).toBeNull();
  });

  it('reads the focus of the latest copy when the offer drawn before Down is still above it', () => {
    const stacked = `${read('claude/2.1.328/fullscreen-renderer.txt')}\n${read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt')}`;
    expect(claudeDialogFocus(stacked, 'claude_fullscreen_renderer')).toBe('second');
  });

  it.each(['claude/2.1.329/onboarding-theme.txt', 'claude/2.1.329/onboarding-security-notes.txt'])(
    '%s is Claude Code onboarding', (file) => {
      expect(detectClaudeStartupDialog(read(file))).toBe('claude_onboarding');
    },
  );

  it('does not read a cwd named "Dark mode" in the banner or the HUD below the live prompt as onboarding', () => {
    const hud = read('claude/2.1.325/idle-hud.txt')
      .replace('/private/tmp/omc-proto-X5IS/work', '/private/tmp/omc-proto-X5IS/work/Dark mode')
      .replace('[OMC#5.8.4] |', '[OMC#5.8.4] | /private/tmp/omc-proto-X5IS/work/Dark mode |');
    expect(detectClaudeStartupDialog(hud)).toBeNull();
  });

  it.each(['>', '›'])('does not read the security notes quoted above a %s input prompt as onboarding', (prompt) => {
    const notes = read('claude/2.1.329/onboarding-security-notes.txt').trimEnd().split('\n').map(line => `  ${line}`).join('\n');
    expect(detectClaudeStartupDialog(`⏺ The worker pane showed:\n${notes}\n\n${prompt} `)).toBeNull();
  });

  it.each([
    ['claude/2.1.328/bypass-permissions.txt', 'claude_bypass_permissions'],
    ['claude/2.1.328/bypass-permissions-yes-focused.txt', 'claude_bypass_permissions'],
    ['claude/2.1.328/fullscreen-renderer.txt', 'claude_fullscreen_renderer'],
  ] as const)('reads %s below a shell prompt ruled like an input box', (file, kind) => {
    const shell = `${'─'.repeat(120)}\n❯ 'env' OMC_WORKER_LAUNCH_SPEC_FILE='/private/tmp/w/bootstrap.json' node runtime-cli.cjs --worker-launch\n`;
    expect(detectClaudeStartupDialog(`${shell}${read(file)}`)).toBe(kind);
  });

  it.each(['onboarding-theme.txt', 'onboarding-security-notes.txt'])('reads %s below an earlier Claude input box', (file) => {
    expect(detectClaudeStartupDialog(`${read('claude/2.1.325/idle.txt').trimEnd()}\n${read(`claude/2.1.329/${file}`)}`)).toBe('claude_onboarding');
  });

  it('still reads onboarding from the theme options alone, the rest scrolled away', () => {
    const options = read('claude/2.1.329/onboarding-theme.txt').split('\n').filter(line => /mode|Auto/.test(line)).join('\n');
    expect(detectClaudeStartupDialog(options)).toBe('claude_onboarding');
    expect(detectClaudeStartupDialog('     Light mode (ANSI colors only)\n\n ╌╌╌╌\n  Syntax theme: Monokai Extended\n (ctrl+t to disable)\n')).toBe('claude_onboarding');
  });

  it('does not read onboarding text quoted in a reply above the input prompt', () => {
    expect(detectClaudeStartupDialog('⏺ It said: Security notes: ... Press Enter to continue, then Choose the text style.\n────\n❯ \n────\n')).toBeNull();
  });

  it('reads the bypass warning by its choices alone, with no heading on screen', () => {
    expect(detectClaudeStartupDialog('  ❯ No, exit\n    Yes, I accept\n  Enter to confirm · Esc to cancel\n')).toBe('claude_bypass_permissions');
    expect(detectClaudeStartupDialog('    No, exit\n  ❯ Yes, I accept\n')).toBe('claude_bypass_permissions');
  });

  it('reads neither dialog once a reply quoting them has the input prompt drawn below', () => {
    const quoted = read('claude/synthetic/output-quoting-first-run-dialogs.txt');
    expect(detectClaudeStartupDialog(quoted)).toBeNull();
    expect(claudeDialogFocus(quoted, 'claude_bypass_permissions')).toBe('stale');
    expect(claudeDialogFocus(quoted, 'claude_fullscreen_renderer')).toBe('stale');
  });

  it('does not read the trust dialog or the pane after Not now as a first-run dialog', () => {
    for (const file of ['claude/2.1.325/trust.txt', 'claude/2.1.328/trust-yes-focused.txt', 'claude/2.1.328/idle-after-fullscreen-renderer.txt']) {
      expect(detectClaudeStartupDialog(read(file)), file).toBeNull();
    }
  });

  it('leaves the trust dialog that offers Yes, proceed to the trust detector, footer drawn or not', () => {
    const legacy = 'Do you trust the files in this folder?\n❯ No, exit\n  Yes, proceed\n';
    expect(detectClaudeStartupDialog(legacy)).toBeNull();
    expect(detectClaudeStartupDialog(`${legacy}\n  Enter to confirm · Esc to cancel\n`)).toBeNull();
  });

  it('waits on the trust choices drawn without their question, which the trust detector does not read', () => {
    expect(detectClaudeStartupDialog('  ❯ No, exit\n    Yes, I trust this folder\n\n  Enter to confirm · Esc to cancel\n'))
      .toBe('claude_startup_dialog_unidentified');
  });

  it('reads No, exit above the footer as the bypass warning when its other choice is worded otherwise', () => {
    expect(detectClaudeStartupDialog('  ❯ No, exit\n    Yes, I agree\n\n  Enter to confirm · Esc to cancel\n'))
      .toBe('claude_bypass_permissions');
  });

  it('waits on the renderer offer until its footer is drawn', () => {
    const offer = read('claude/2.1.328/fullscreen-renderer.txt');
    expect(detectClaudeStartupDialog(offer.replace('Enter to confirm · Esc to cancel', '')))
      .toBe('claude_startup_dialog_unidentified');
  });

  it('reads no focus on the renderer offer while neither choice is marked', () => {
    const offer = read('claude/2.1.328/fullscreen-renderer.txt').replace('❯ 1. Yes, try it', '  1. Yes, try it');
    expect(detectClaudeStartupDialog(offer)).toBe('claude_fullscreen_renderer');
    expect(claudeDialogFocus(offer, 'claude_fullscreen_renderer')).toBeNull();
  });

  it.each([6, 8])('reads the renderer offer and its focus with the focused choice wrapped over three lines at %i columns', (cols) => {
    for (const [file, focus] of [
      ['claude/2.1.328/fullscreen-renderer.txt', 'first'],
      ['claude/2.1.328/fullscreen-renderer-not-now-focused.txt', 'second'],
    ] as const) {
      const wrapped = hardWrap(read(file), cols);
      expect(detectClaudeStartupDialog(wrapped), file).toBe('claude_fullscreen_renderer');
      expect(claudeDialogFocus(wrapped, 'claude_fullscreen_renderer'), file).toBe(focus);
    }
  });

  it('reads the focus of the latest copy when the offer drawn after Not now focuses Yes again', () => {
    const stacked = `${read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt')}\n${read('claude/2.1.328/fullscreen-renderer.txt')}`;
    expect(claudeDialogFocus(stacked, 'claude_fullscreen_renderer')).toBe('first');
  });

  // Any one part of onboarding on screen names it, as a short pane or a
  // capture taken while Claude Code draws the screen can show only that part.
  it.each([
    " Let's get started.",
    ' Choose the text style that looks best',
    ' To change this later, run /theme',
    '     Dark mode (colorblind-friendly)',
    '     Light mode (colorblind-friendly)',
    '     Dark mode (ANSI colors only)',
    '     Light mode (ANSI colors only)',
    '     Dark mode\n     Light mode',
    '  Syntax theme: Monokai Extended',
    ' (ctrl+t to disable)',
    ' Security notes:',
    ' 1. Claude can make mistakes.',
    ' 2. Due to prompt injection risks, only',
    ' Press Enter to continue',
  ])('reads onboarding from %j alone', (part) => {
    expect(detectClaudeStartupDialog(`${part}\n`)).toBe('claude_onboarding');
  });

  // The focused theme (❯, and ✔ on the theme in use) is drawn like an input
  // prompt. Captured before the lines below it are drawn, it is still read as
  // a choice, so the picker above it still names onboarding.
  it.each([
    ['✔ Auto (match terminal)', 'Auto (match terminal)'],
    ['Dark mode', 'Dark mode'],
    ['✔ Dark mode', 'Dark mode'],
    ['Light mode', 'Light mode'],
    ['Dark mode (colorblind-friendly)', 'Dark mode (colorblind-friendly)'],
    ['Light mode (colorblind-friendly)', 'Light mode (colorblind-friendly)'],
    ['Dark mode (ANSI colors only)', 'Dark mode (ANSI colors only)'],
    ['Light mode (ANSI colors only)', 'Light mode (ANSI colors only)'],
  ])('reads onboarding with ❯ %s as the last line drawn', (focused, choice) => {
    const lines = read('claude/2.1.329/onboarding-theme.txt').replace('❯ ✔ Auto', '    Auto').split('\n');
    const at = lines.findIndex(line => line.trim() === choice);
    const picker = [...lines.slice(0, at), ` ❯ ${focused}`].join('\n');
    expect(detectClaudeStartupDialog(`${picker}\n`)).toBe('claude_onboarding');
  });

  it('reads a prompt holding typed text as a prompt, even text that begins or starts a choice', () => {
    const notes = read('claude/2.1.329/onboarding-security-notes.txt');
    expect(detectClaudeStartupDialog(`${notes}\n❯ Dark mode looks fine\n`)).toBeNull();
    expect(detectClaudeStartupDialog(`${notes}\n❯ Yes\n`)).toBeNull();
  });

  it('reads an empty input prompt as a prompt, even with a theme name right below it', () => {
    expect(detectClaudeStartupDialog('Security notes:\n❯\nDark mode\n')).toBeNull();
  });

  // Asked about a dialog that is not the live one, claudeDialogFocus names no
  // focus when neither of its choices is on screen, and 'stale' when any one is.
  it('reads no renderer focus on an idle pane, and a stale one when either choice is left above the prompt', () => {
    expect(claudeDialogFocus(read('claude/2.1.325/idle.txt'), 'claude_fullscreen_renderer')).toBeNull();
    expect(claudeDialogFocus('  ❯ 1. Yes, try it\n────\n❯ \n────\n', 'claude_fullscreen_renderer')).toBe('stale');
    expect(claudeDialogFocus('    2. Not now\n────\n❯ \n────\n', 'claude_fullscreen_renderer')).toBe('stale');
    expect(claudeDialogFocus('  ❯ 1. Yes,\n  try it\n────\n❯ \n────\n', 'claude_fullscreen_renderer')).toBe('stale');
  });

  // Claude Code draws a no-break space after the ❯ of its own input prompt.
  it('reads the renderer focus when a no-break space follows its ❯', () => {
    const offer = read('claude/2.1.328/fullscreen-renderer.txt').replace('❯ 1. Yes, try it', '❯\u00a01. Yes, try it');
    expect(detectClaudeStartupDialog(offer)).toBe('claude_fullscreen_renderer');
    expect(claudeDialogFocus(offer, 'claude_fullscreen_renderer')).toBe('first');
  });

  it('reads only below the boxed input prompt of Claude Code 2.1.142', () => {
    const notes = read('claude/2.1.329/onboarding-security-notes.txt');
    expect(detectClaudeStartupDialog(`⏺ The worker pane showed:\n${notes}\n${read('claude/2.1.142/idle-gutter.txt')}`)).toBeNull();
  });

  it('reads only below the latest input prompt when an earlier one is in the scrollback', () => {
    const notes = read('claude/2.1.329/onboarding-security-notes.txt');
    expect(detectClaudeStartupDialog(`❯ earlier request\n⏺ The worker pane showed:\n${notes}\n────\n❯ \n────\n`)).toBeNull();
  });

  it('leaves the trust detector, observePane and classifyPane as they were, for every provider', () => {
    const cursorQuote = `${read('claude/synthetic/output-quoting-first-run-dialogs.txt').split('────')[0]}\n→ ready\n`;
    for (const captured of [...DIALOGS.map(([file]) => read(file)), cursorQuote]) {
      for (const provider of [undefined, 'claude', 'codex', 'cursor'] as const) {
        expect(detectPaneTrustPromptKind(captured, provider)).toBeNull();
        expect(observePane(captured, provider).trust).toBeNull();
      }
      expect(classifyPane(observePane(captured)).kind).toBe('idle');
    }
  });
});

// Claude Code 2.1.330 draws its trust dialog over several captures. A capture
// cut below the focused choice shows a ❯ line, which the ready detector reads
// as an input box; the startup wait must read it as a dialog still drawing.
describe('the Claude trust dialog captured while it draws', () => {
  const WHOLE = [
    'claude/2.1.330/trust.txt',
    'claude/2.1.330/trust-80col.txt',
    'claude/2.1.330/trust-60col.txt',
    'claude/2.1.325/trust.txt',
    'claude/2.1.310/trust-35col.txt',
    'claude/2.1.310/trust-59col.txt',
  ];
  const YES_FOCUSED = ['claude/2.1.330/trust-yes-focused.txt', 'claude/2.1.328/trust-yes-focused.txt'];
  const QUESTION = 'Quick safety check: Is this a project you created or one you trust?';

  // What the startup wait would type the trigger into: no dialog read, no
  // trust dialog read, and an input box seen.
  const readAsInputBox = (captured: string) =>
    detectClaudeStartupDialog(captured) === null &&
    detectPaneTrustPromptKind(captured, 'claude') === null &&
    paneLooksReady(captured, 'claude');
  const endOfLine = (text: string, pattern: RegExp) => {
    const match = new RegExp(`^.*${pattern.source}.*$`, 'm').exec(text)!;
    return match.index + match[0].length;
  };
  // Each capture taken while the text from `from` to `to` is drawn: nothing
  // below the cut is on screen yet.
  const cutsBetween = (text: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => text.slice(0, from + index));
  const cutsByLine = (text: string) => {
    const lines = text.split('\n');
    const question = lines.findIndex(line => /Quick safety check|Do you trust the files/.test(line));
    const footer = lines.findIndex(line => line.includes('Enter to confirm'));
    return Array.from({ length: footer - question + 1 }, (_, index) => `${lines.slice(0, question + index + 1).join('\n')}\n`);
  };

  it.each(WHOLE)('never reads %s cut at any line or character as an input box', (file) => {
    const whole = frame(file);
    const cuts = [
      ...cutsByLine(whole),
      ...cutsBetween(whole, endOfLine(whole, /Security guide/), endOfLine(whole, /Yes, I trust this folder/)),
    ];
    expect(cuts.filter(readAsInputBox)).toEqual([]);
  });

  // After Down, Claude Code redraws both choices: "No, exit" loses the ❯ and
  // "Yes, I trust this folder" gains it, in either order.
  it.each(YES_FOCUSED.flatMap(file => [[file, 'No redrawn first'], [file, 'Yes redrawn first']] as const))(
    'never reads %s cut while redrawn after Down (%s) as an input box',
    (file, order) => {
      const yes = frame(file);
      const redrawn = order === 'No redrawn first' ? yes : yes.replace(/^(\s*) {2}No, exit/m, '$1❯ No, exit');
      const cuts = cutsBetween(redrawn, endOfLine(redrawn, /No, exit/), endOfLine(redrawn, /Yes, I trust this folder/));
      expect(cuts.filter(readAsInputBox)).toEqual([]);
      expect(detectPaneTrustPromptKind(cuts.at(-1)!, 'claude')).toBe('claude_directory');
    },
  );

  it.each(WHOLE)('still reads %s as the trust dialog once its Yes line is drawn, footer or not', (file) => {
    const whole = frame(file);
    for (const cut of cutsBetween(whole, endOfLine(whole, /Yes, I trust this folder/), whole.length)) {
      expect(detectPaneTrustPromptKind(cut, 'claude')).toBe('claude_directory');
      expect(detectClaudeStartupDialog(cut)).toBeNull();
    }
  });

  it.each([
    ['the recorded frame cut at "❯ No, exi"', (): string => frame('claude/2.1.330/trust-no-choice-partial.txt')],
    ['the recorded frame cut at "Yes, I trust th"', (): string => frame('claude/2.1.330/trust-yes-choice-partial.txt')],
    ['a redraw after Down cut at "❯ Yes, I tr"', (): string => `${QUESTION}\nSecurity guide\n  No, exit\n❯ Yes, I tr\n`],
    ['a redraw after Down cut at "❯ Yes, I tr" with the old ❯ still on No', (): string => `${QUESTION}\nSecurity guide\n❯ No, exit\n❯ Yes, I tr\n`],
  ])('reads %s as a first-run dialog still drawing', (_, captured) => {
    expect(detectClaudeStartupDialog(captured())).toBe('claude_startup_dialog_unidentified');
  });

  it.each([
    ['an answered trust dialog above a boxed input prompt', (): string => `${frame('claude/2.1.330/trust.txt')}\n${frame('claude/2.1.325/idle.txt')}`],
    ['the trust question quoted in a reply above a boxed input prompt', (): string => `⏺ The pane asked: ${QUESTION}\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n`],
    ['"No, exit" typed into a boxed input prompt below the quoted question', (): string => `⏺ ${QUESTION}\n${'─'.repeat(40)}\n❯ No, exit\n${'─'.repeat(40)}\n`],
    // Each of the next three differs from a dialog still drawing in one way only.
    ['"Yes, I tr" typed below the quoted question, with no "No, exit" above it', (): string => `⏺ ${QUESTION}\n❯ Yes, I tr\n`],
    ['"Yes" typed below a quoted "No, exit", with a rule drawn below it', (): string => `⏺ ${QUESTION}\n  No, exit\n❯ Yes\n${'─'.repeat(40)}\n`],
    ['the choices quoted below the question, "Yes" then a rule below "❯ No, exit"', (): string => `⏺ ${QUESTION}\n❯ No, exit\n  Yes\n${'─'.repeat(40)}\n`],
  ])('reads %s as it did before', (_, captured) => {
    expect(detectClaudeStartupDialog(captured())).toBeNull();
    expect(paneLooksReady(captured(), 'claude')).toBe(true);
  });
});
