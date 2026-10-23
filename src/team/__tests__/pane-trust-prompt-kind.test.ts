import { describe, expect, it } from 'vitest';
import { detectPaneTrustPromptKind, type PaneTrustPromptKind } from '../tmux-session.js';
import type { CliAgentType } from '../model-contract.js';

const codexFolderTrust = [
  'Folder access', '/repo',
  'Trust this folder? Codex can read, edit, and',
  'run files here, subject to your permission',
  'settings.',
  '› 1. Trust and continue', '  2. Quit',
  'enter continue · esc quit',
].join('\n');

const codexFolderTrustAnswered = [
  'Trust this folder?', '› 1. Trust and continue', '  2. Quit',
  '› ready',
].join('\n');

const cursorWorkspaceTrust = [
  'Workspace Trust Required',
  'Do you trust the contents of this directory?',
  'Pass --trust, --yolo, or -f to skip this prompt.',
].join('\n');

const claudeFilesTrust = [
  'Do you trust the files in this folder?',
  '❯ No, exit',
  '  Yes, proceed',
].join('\n');

const claudeQuickSafetyCheck = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ No, exit',
  '  Yes, I trust this folder',
].join('\n');

const directoryTrust = [
  'Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
].join('\n');

const codexHooksReview = [
  'Hooks need review',
  '› 3. Continue without trusting',
  'Press enter to confirm or esc to go back',
].join('\n');

const idlePrompt = ['Some earlier output', '› ready'].join('\n');

const cursorBannerWithDirectoryChoices = [
  'Workspace Trust Required',
  'Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
].join('\n');

// Unlike Codex, the Claude rule has no answered-dialog check yet: a dialog
// still inside the 12-line tail is reported even after an idle prompt.
const claudeFilesTrustThenIdle = [claudeFilesTrust, '❯ '].join('\n');

type Row = readonly [label: string, capture: string, provider: CliAgentType | undefined, expected: PaneTrustPromptKind | null];

const rows: readonly Row[] = [
  ['codex folder trust, provider-agnostic', codexFolderTrust, undefined, 'codex_directory'],
  ['codex folder trust, codex', codexFolderTrust, 'codex', 'codex_directory'],
  ['codex folder trust is not claimed for claude', codexFolderTrust, 'claude', null],
  ['answered codex folder trust', codexFolderTrustAnswered, 'codex', null],
  ['cursor workspace trust, provider-agnostic', cursorWorkspaceTrust, undefined, 'cursor_workspace_trust'],
  ['cursor workspace trust, cursor', cursorWorkspaceTrust, 'cursor', 'cursor_workspace_trust'],
  ['claude files trust, provider-agnostic', claudeFilesTrust, undefined, 'claude_directory'],
  ['claude files trust, claude', claudeFilesTrust, 'claude', 'claude_directory'],
  ['claude files trust is not claimed for codex', claudeFilesTrust, 'codex', null],
  ['claude files trust is not claimed for gemini', claudeFilesTrust, 'gemini', null],
  ['claude files trust above an idle prompt is still reported', claudeFilesTrustThenIdle, undefined, 'claude_directory'],
  ['claude quick safety check, provider-agnostic', claudeQuickSafetyCheck, undefined, 'claude_directory'],
  ['claude quick safety check, claude', claudeQuickSafetyCheck, 'claude', 'claude_directory'],
  ['claude quick safety check is not claimed for codex', claudeQuickSafetyCheck, 'codex', null],
  ['cursor banner wins over generic directory choices', cursorBannerWithDirectoryChoices, undefined, 'cursor_workspace_trust'],
  ['directory trust, provider-agnostic', directoryTrust, undefined, 'directory'],
  ['directory trust, codex', directoryTrust, 'codex', 'directory'],
  ['codex hooks review, provider-agnostic', codexHooksReview, undefined, 'codex_hooks'],
  ['codex hooks review, codex', codexHooksReview, 'codex', 'codex_hooks'],
  ['idle prompt, provider-agnostic', idlePrompt, undefined, null],
  ['idle prompt, claude', idlePrompt, 'claude', null],
  ['empty capture', '', undefined, null],
];

describe('detectPaneTrustPromptKind', () => {
  it.each(rows)('%s', (_label, capture, provider, expected) => {
    expect(detectPaneTrustPromptKind(capture, provider)).toBe(expected);
  });
});
