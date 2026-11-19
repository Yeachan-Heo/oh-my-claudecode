import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CliAgentType } from '../model-contract.js';
import {
  claudeTrustFocus,
  classifyPane,
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
  'claude/2.1.328/trust-yes-focused.txt': 'trust:claude_directory idlePrompt',
  'claude/synthetic/loading-in-scrollback.txt': 'bootstrapping idlePrompt',
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

describe('claudeTrustFocus', () => {
  const read = (file: string) => readFileSync(join(CORPUS_ROOT, file), 'utf8');
  const STALE_YES = ' ❯ Yes, I trust this folder\n';
  const trust = read('claude/2.1.325/trust.txt');
  const midDraw = trust.slice(0, trust.indexOf('Security guide') + 'Security guide'.length);

  it.each([
    ['claude/2.1.328/trust-yes-focused.txt', 'yes'],
    ['claude/2.1.325/trust.txt', 'no'],
    ['claude/2.1.310/trust-35col.txt', 'no'],
    ['claude/unversioned/trust-files-wrapped.txt', 'no'],
  ] as const)('%s -> %s', (file, focus) => {
    expect(claudeTrustFocus(read(file))).toBe(focus);
  });

  it('reads the 35-column dialog once Down moved its focus', () => {
    const moved = read('claude/2.1.310/trust-35col.txt')
      .replace(' ❯ No, exit', '   No, exit')
      .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
    expect(claudeTrustFocus(moved)).toBe('yes');
  });

  it('ignores a stale focused Yes in the scrollback above a live dialog focused on No', () => {
    expect(claudeTrustFocus(`${STALE_YES}${trust}`)).toBe('no');
  });

  it('reads an answered dialog with the input prompt drawn below its choices as stale', () => {
    expect(claudeTrustFocus(read('claude/unversioned/trust-files-then-idle.txt'))).toBe('stale');
  });

  it('reads no focus while a new dialog below an answered one has not drawn its choices', () => {
    expect(claudeTrustFocus(midDraw)).toBeNull();
    expect(claudeTrustFocus(`${read('claude/2.1.328/trust-yes-focused.txt')}\n${midDraw}`)).toBeNull();
  });
});
