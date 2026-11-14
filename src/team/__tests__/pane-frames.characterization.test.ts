import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CliAgentType } from '../model-contract.js';
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
  note?: string;
}

interface Outputs {
  ready: boolean;
  busy: boolean;
  trust: PaneTrustPromptKind | null;
}

type Row = Outputs & ({ known_wrong?: undefined } | { known_wrong: true; reason: string });

const TRUST_READY = 'a trust prompt is reported ready';
const BUSY_READY = 'ready and busy at once: the input box stays drawn while the provider works';

const TABLE: Readonly<Record<string, Row>> = {
  'claude/2.1.142/idle-bypass.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.142/idle-gutter.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.310/trust-35col.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/2.1.310/trust-59col-partial.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/2.1.310/trust-59col.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/2.1.325/busy-after-blocked-stop.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-blocked-stop-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-posttooluse-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-spinner.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-stop-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-tokens.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/busy-userpromptsubmit-hook.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/2.1.325/done-after-blocked-stop.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/done.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/idle-first-paint.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/idle-hud.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/idle-mode-footer.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/idle-sessionstart-hook-error.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/idle.txt': { ready: true, busy: false, trust: null },
  'claude/2.1.325/trust-just-answered.txt': { ready: false, busy: false, trust: null },
  'claude/2.1.325/trust.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/synthetic/loading-in-scrollback.txt': { ready: false, busy: false, trust: null, known_wrong: true, reason: '"loading" anywhere in scrollback reads as bootstrapping, so an idle pane is never ready' },
  'claude/synthetic/prompt-glyph-in-output.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'a quoted "> " line in model output reads as an idle prompt before any input box exists' },
  'claude/synthetic/shell-prompt-after-exit-dollar.txt': { ready: false, busy: false, trust: null },
  'claude/synthetic/shell-prompt-after-exit-heavy-angle.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using ❯ reads as an idle provider prompt' },
  'claude/unversioned/busy-compacting-suffix.txt': { ready: false, busy: true, trust: null },
  'claude/unversioned/busy-thinking-after-trigger.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/unversioned/busy-thinking-esc.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'claude/unversioned/idle-below-bypass-banner.txt': { ready: true, busy: false, trust: null },
  'claude/unversioned/idle-welcome-greater-than.txt': { ready: true, busy: false, trust: null },
  'claude/unversioned/idle-welcome.txt': { ready: true, busy: false, trust: null },
  'claude/unversioned/output-quoting-trust-choices.txt': { ready: true, busy: false, trust: null },
  'claude/unversioned/startup-banner-bypass.txt': { ready: false, busy: false, trust: null },
  'claude/unversioned/startup-trigger-pending.txt': { ready: true, busy: false, trust: null },
  'claude/unversioned/trust-files-question.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/unversioned/trust-files-then-idle.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: 'trust is still reported after the dialog was answered and an idle prompt is drawn' },
  'claude/unversioned/trust-files-wrapped.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/unversioned/trust-quick-safety-check.txt': { ready: true, busy: false, trust: 'claude_directory', known_wrong: true, reason: TRUST_READY },
  'claude/unversioned/unrelated-input.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/busy.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'codex/0.167.0/done-reconnecting.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/done.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/idle-before-trust.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'codex draws its idle prompt about 0.25s before the folder-trust dialog replaces it' },
  'codex/0.167.0/idle.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/prompt-typed-unsubmitted.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/startup-loading.txt': { ready: false, busy: false, trust: null },
  'codex/0.167.0/trust-just-answered.txt': { ready: true, busy: false, trust: null },
  'codex/0.167.0/trust.txt': { ready: false, busy: false, trust: 'codex_directory' },
  'codex/synthetic/shell-prompt-after-exit-single-angle.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using › reads as an idle provider prompt' },
  'codex/unversioned/busy-esc.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'codex/unversioned/hooks-review-short.txt': { ready: true, busy: false, trust: 'codex_hooks', known_wrong: true, reason: TRUST_READY },
  'codex/unversioned/hooks-review.txt': { ready: true, busy: false, trust: 'codex_hooks', known_wrong: true, reason: TRUST_READY },
  'codex/unversioned/idle-ready.txt': { ready: true, busy: false, trust: null },
  'codex/unversioned/trust-directory-legacy.txt': { ready: true, busy: false, trust: 'directory', known_wrong: true, reason: TRUST_READY },
  'codex/unversioned/trust-directory-with-interrupt-text.txt': { ready: true, busy: true, trust: 'directory', known_wrong: true, reason: TRUST_READY },
  'codex/unversioned/trust-folder-answered.txt': { ready: true, busy: false, trust: null },
  'codex/unversioned/trust-folder-partial.txt': { ready: false, busy: false, trust: 'codex_directory' },
  'codex/unversioned/trust-folder-windows.txt': { ready: false, busy: false, trust: 'codex_directory' },
  'codex/unversioned/trust-folder.txt': { ready: false, busy: false, trust: 'codex_directory' },
  'cursor/synthetic/shell-prompt-after-exit-greater-than.txt': { ready: true, busy: false, trust: null, known_wrong: true, reason: 'the provider has exited; a shell prompt using > reads as an idle provider prompt' },
  'cursor/unversioned/busy-ctrl-c.txt': { ready: true, busy: true, trust: null, known_wrong: true, reason: BUSY_READY },
  'cursor/unversioned/idle-arrow.txt': { ready: true, busy: false, trust: null },
  'cursor/unversioned/workspace-trust-short.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust-with-choices-and-hint.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust-with-directory-choices.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust' },
  'cursor/unversioned/workspace-trust.txt': { ready: false, busy: false, trust: 'cursor_workspace_trust' },
};

const manifest = JSON.parse(readFileSync(join(CORPUS_ROOT, 'manifest.json'), 'utf8')) as ManifestEntry[];

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fixtureFiles(path);
    return entry.name.endsWith('.txt') ? [relative(CORPUS_ROOT, path)] : [];
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
