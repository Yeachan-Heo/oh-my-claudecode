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

// Captured from Claude Code 2.1.310 in tmux (blank lines and the lines above
// the question dropped). The worker pane is 59 columns beside a half-width
// leader in a 120-column window; Claude Code wraps the question itself.
const claudeCode2_1_310Dialog59Columns = [
  ' Quick safety check: Is this a project you created or one',
  ' you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment',
  " to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files",
  ' here.',
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

// A 35-column pane: the question starts 13 non-empty lines from the bottom.
const claudeCode2_1_310Dialog35Columns = [
  ' Quick safety check: Is this a',
  ' project you created or one you',
  ' trust? (Like your own code, a',
  ' well-known open source project,',
  ' or work from your team). If not,',
  " take a moment to review what's in",
  ' this folder first.',
  " Claude Code'll be able to read,",
  ' edit, and execute files here.',
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

// Not captured: the older wording wrapped in a narrow pane.
const claudeFilesTrustWrapped = [' Do you trust the files in this', ' folder?', ' ❯ No, exit', '   Yes, proceed'].join('\n');

// A working session that writes about the dialog without the question itself.
const workerOutputQuotingDialogChoices = [
  '⏺ Quick safety check: the startup loop answers the trust dialog.',
  '  It moves from "No, exit" to "Yes, I trust this folder" with Down.',
  '❯ ',
].join('\n');

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
  ['claude code 2.1.310 dialog wrapped at 59 columns, claude', claudeCode2_1_310Dialog59Columns, 'claude', 'claude_directory'],
  ['claude code 2.1.310 dialog wrapped at 59 columns, provider-agnostic', claudeCode2_1_310Dialog59Columns, undefined, 'claude_directory'],
  ['claude code 2.1.310 dialog wrapped at 35 columns, claude', claudeCode2_1_310Dialog35Columns, 'claude', 'claude_directory'],
  ['claude code 2.1.310 dialog wrapped at 35 columns, provider-agnostic', claudeCode2_1_310Dialog35Columns, undefined, 'claude_directory'],
  ['claude files trust wrapped across two lines', claudeFilesTrustWrapped, 'claude', 'claude_directory'],
  ['worker output with the opening words and both choices is not a dialog', workerOutputQuotingDialogChoices, undefined, null],
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
