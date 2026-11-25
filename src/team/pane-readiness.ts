import type { CliAgentType } from './model-contract.js';

export type PaneTrustPromptKind =
  | 'directory'
  | 'claude_directory'
  | 'codex_directory'
  | 'codex_hooks'
  | 'cursor_workspace_trust';

/**
 * What one pane capture shows. The signals are independent: a working provider
 * keeps its input box drawn, so `idlePrompt` and `busy` are often both true.
 */
export interface PaneSignals {
  trust: PaneTrustPromptKind | null;
  /** A startup word anywhere on screen, or the startup banner. Read before sending keys. */
  bootstrapping: boolean;
  /**
   * A startup word on a status line, or the startup banner. Read by classifyPane,
   * so a reply that mentions "loading" does not keep an idle pane starting.
   */
  startupStatus: boolean;
  idlePrompt: boolean;
  busy: boolean;
}

export interface ProviderPanePatterns {
  readonly idlePromptLine: RegExp;
  readonly busyLines: readonly RegExp[];
  /** Counts as bootstrapping only while no idle prompt is drawn. */
  readonly startupBannerLines: readonly RegExp[];
  readonly loadingLines: readonly RegExp[];
  readonly startupStatusLines: readonly RegExp[];
  readonly trustKinds: readonly PaneTrustPromptKind[];
  /** Provider version whose recorded frames are in the pane-frame corpus. */
  readonly verifiedVersion: string | null;
}

const LEGACY_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯]\s*/u;
const CURSOR_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯→]\s*/u;

const SHARED_BUSY_LINES: readonly RegExp[] = [
  /esc to interrupt/i,
  /\bbackground terminal running\b/i,
  /^[·✻✢✳✶✽✺✹✸✷*]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})(?:\s*\(.*\))?$/u,
];

// Every provider is checked against these today, not only the one that draws them.
const SHARED_PATTERNS = {
  idlePromptLine: LEGACY_IDLE_PROMPT_LINE,
  busyLines: SHARED_BUSY_LINES,
  startupBannerLines: [
    /bypass\s+permissions\s+on/i,
    /shift\+tab\s+to\s+cycle/i,
    /^⏵⏵\s+/,
  ],
  loadingLines: [
    /\b(loading|initializing|starting up)\b/i,
    /\bconnecting\s+to\b/i,
  ],
  // A status line starts with the startup word, inside an optional box border.
  // Behind a spinner it may be any length, since it names what loads or
  // connects. A spinner is a braille frame or one of Claude's spinner glyphs;
  // any other leading mark opens output, a list item, quoted text or an input
  // prompt. Without a spinner the line is short, not counting the padding and
  // border of a box. Gemini's own status lines are read in their exact form,
  // with or without its spinner, since they can grow long: "Resuming
  // session..." alone or opening its MCP progress, which wraps in a narrow pane,
  // and "Connecting to MCP servers... (n/m)" alone or with the servers it waits for.
  startupStatusLines: [
    /^(?:[│┃║▌▐▏▕╎┆┊]\s*)?[\u2800-\u28FF·✻✢✳✶✽✺✹✸✷]\s*(?:model:\s*)?(?:loading|initializing|starting up|connecting\s+to)\b/iu,
    /^(?:[│┃║▌▐▏▕╎┆┊]\s*)?(?:model:\s*)?(?:loading|initializing|starting up|connecting\s+to)\b.{0,40}?\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?$/iu,
    /^(?:[│┃║▌▐▏▕╎┆┊]\s*)?(?:[\u2800-\u28FF]\s*)?(?:Resuming session\.\.\.(?: \(|\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?$)|Connecting to MCP servers\.\.\. \(\d+\/\d+\)(?: - Waiting for: .+)?\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?$)/u,
  ],
  trustKinds: ['directory', 'codex_hooks'],
  verifiedVersion: null,
} as const satisfies ProviderPanePatterns;

export const PANE_PATTERNS: Readonly<Record<CliAgentType, ProviderPanePatterns>> = {
  claude: {
    ...SHARED_PATTERNS,
    trustKinds: ['claude_directory', ...SHARED_PATTERNS.trustKinds],
    verifiedVersion: '2.1.325',
  },
  codex: {
    ...SHARED_PATTERNS,
    trustKinds: ['codex_directory', ...SHARED_PATTERNS.trustKinds],
    verifiedVersion: '0.167.0',
  },
  gemini: SHARED_PATTERNS,
  cursor: {
    ...SHARED_PATTERNS,
    idlePromptLine: CURSOR_IDLE_PROMPT_LINE,
    busyLines: [/ctrl\+c\s+to\s+stop/i, ...SHARED_BUSY_LINES],
    trustKinds: ['cursor_workspace_trust', ...SHARED_PATTERNS.trustKinds],
  },
  grok: SHARED_PATTERNS,
  antigravity: SHARED_PATTERNS,
};

// A caller that does not know the provider accepts every provider's trust dialog.
const UNKNOWN_PROVIDER_PATTERNS: ProviderPanePatterns = {
  ...SHARED_PATTERNS,
  trustKinds: [
    'codex_directory',
    'cursor_workspace_trust',
    'claude_directory',
    ...SHARED_PATTERNS.trustKinds,
  ],
};

// A provider name outside the table, such as one cast from stored team state,
// gets the shared patterns, which is how the checks read it before the table:
// only the shared trust dialogs, busy markers and prompt.
function patternsFor(provider: CliAgentType | undefined): ProviderPanePatterns {
  if (provider === undefined) return UNKNOWN_PROVIDER_PATTERNS;
  return Object.hasOwn(PANE_PATTERNS, provider) ? PANE_PATTERNS[provider] : SHARED_PATTERNS;
}

function paneLines(captured: string): string[] {
  return captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
}

function anyLineMatches(
  lines: readonly string[],
  patterns: readonly RegExp[],
): boolean {
  return lines.some((line) => patterns.some((pattern) => pattern.test(line)));
}

export function paneLineLooksLikeIdlePrompt(
  line: string,
  provider?: CliAgentType,
): boolean {
  return patternsFor(provider).idlePromptLine.test(line);
}

function codexTrustQuestionIsActive(lines: readonly string[]): boolean {
  const codexPromptLine = PANE_PATTERNS.codex.idlePromptLine;
  const promptText = (line: string) => line.replace(codexPromptLine, '');
  const isTrustChoice = (text: string) => /^(?:1(?:\.|$)|2(?:\.|$))/i.test(text);

  const lastQuestionIndex = lines.findLastIndex((_, index) =>
    /Trust this folder\?/i.test(lines.slice(index, index + 2).join(' ')),
  );
  if (lastQuestionIndex < 0) return false;
  const lastPromptIndex = lines.findLastIndex((line) =>
    codexPromptLine.test(line),
  );
  if (lastPromptIndex < lastQuestionIndex) return true;

  const activePrompt = promptText(lines[lastPromptIndex]!);
  if (isTrustChoice(activePrompt)) return true;
  const previousChoiceWasRendered = lines
    .slice(lastQuestionIndex + 1, lastPromptIndex)
    .some((line) => isTrustChoice(promptText(line)));
  return activePrompt === '' && !previousChoiceWasRendered;
}

// True when the question, wrapped over at most 3 lines, is in the lines from index on.
function claudeTrustQuestionStartsAt(lines: readonly string[], index: number): boolean {
  return /(?:Do you trust the files in this folder|Quick safety check:\s*Is this a project you created or one you trust)\?/i.test(
    lines.slice(index, index + 3).join(' '),
  );
}

// The screens Claude Code shows on the first launch with a fresh config
// directory: onboarding before the trust dialog (recorded on 2.1.329), the
// bypass warning and the renderer offer after it (recorded on 2.1.328). Only
// the Claude startup wait reads them; every other pane reader sees what it saw
// before them. 'claude_startup_dialog_unidentified' is a dialog whose choices
// are off screen or not drawn yet.
export type ClaudeStartupDialogKind =
  | 'claude_onboarding'
  | 'claude_bypass_permissions'
  | 'claude_fullscreen_renderer'
  | 'claude_startup_dialog_unidentified';
export type ClaudeDialogKind = 'claude_directory' | 'claude_bypass_permissions' | 'claude_fullscreen_renderer';

// Every dialog is read from the capture with all whitespace removed, so how
// the pane wraps it (Claude Code at a space, tmux mid-word, a choice split over
// two lines) cannot hide it. A short pane with no scrollback can also lose the
// dialog's top, so any part of one counts: a dialog seen in part gets no
// trigger and no Enter.
const CLAUDE_STARTUP_CHOICES = {
  claude_bypass_permissions: ['No,exit', 'Yes,Iaccept'],
  claude_fullscreen_renderer: ['1.Yes,tryit', '2.Notnow'],
} as const;
const CLAUDE_TRUST_CHOICES = ['Yes,Itrustthisfolder', 'Yes,proceed'];
// Onboarding's theme picker and security notes, in parts that each survive a
// pane too short for the whole screen. A theme name counts only as the picker
// draws it, never as a bare "Dark mode" that a path could also hold.
const CLAUDE_THEME_CHOICES = [
  'Auto(matchterminal)',
  'Darkmode',
  'Lightmode',
  'Darkmode(colorblind-friendly)',
  'Lightmode(colorblind-friendly)',
  'Darkmode(ANSIcolorsonly)',
  'Lightmode(ANSIcolorsonly)',
];
const CLAUDE_ONBOARDING_TEXT = [
  "Let'sgetstarted.",
  'Choosethetextstyle',
  'Tochangethislater,run/theme',
  ...CLAUDE_THEME_CHOICES.filter((choice) => choice.includes('(')),
  'DarkmodeLightmode',
  'Syntaxtheme:',
  '(ctrl+ttodisable)',
  'Securitynotes:',
  'Claudecanmakemistakes',
  'Duetopromptinjectionrisks',
  'PressEntertocontinue',
];
// The footer below the trust dialog and both first-run dialogs.
const CLAUDE_DIALOG_FOOTER = 'Entertoconfirm·Esctocancel';
// The first line of each first-run dialog: every copy of it starts here.
const CLAUDE_STARTUP_HEADINGS = {
  claude_bypass_permissions: 'WARNING:ClaudeCoderunninginBypassPermissionsmode',
  claude_fullscreen_renderer: 'Trythenewfullscreenrenderer?',
} as const;
const CLAUDE_CHOICES: readonly string[] = [
  ...Object.values(CLAUDE_STARTUP_CHOICES).flat(),
  ...CLAUDE_TRUST_CHOICES,
  ...CLAUDE_THEME_CHOICES,
];

const squeeze = (text: string) => text.replace(/\s+/g, '');

// A line the ready detector reads as an input prompt can instead be a dialog
// choice focused with ❯ (a theme choice also with ✔), wrapped over the next
// lines in a narrow pane. It is a choice only if the line holds nothing else.
function lineMarksClaudeChoice(lines: readonly string[], index: number): boolean {
  const rest = squeeze(lines[index]!.replace(PANE_PATTERNS.claude.idlePromptLine, '')).replace(/^✔/u, '');
  if (!rest) return false;
  const drawn = rest + squeeze(lines.slice(index + 1, index + 4).join(''));
  return CLAUDE_CHOICES.some((choice) => choice.startsWith(rest) && drawn.startsWith(choice));
}

// The squeezed capture below the last live input prompt, as the ready detector
// reads prompts (❯, ›, >), not counting a focused dialog choice. A dialog quoted
// above that prompt is not on screen. What sits below it is always read, the
// HUD included: a screen missed here could get the trigger and Enter, while one
// read wrongly only stops the start.
function claudeDialogTail(captured: string): string {
  const lines = paneLines(captured);
  const prompt = lines.findLastIndex(
    (line, index) => PANE_PATTERNS.claude.idlePromptLine.test(line) && !lineMarksClaudeChoice(lines, index),
  );
  return squeeze(lines.slice(prompt + 1).join(''));
}

// The dialog whose choice (or onboarding text) is drawn last is the live one:
// an answered dialog can remain above it. "No, exit" alone is the bypass warning only with the
// footer, as the trust dialog draws it too.
function claudeStartupDialogIn(tail: string, captured: string): ClaudeStartupDialogKind | null {
  const footer = tail.includes(CLAUDE_DIALOG_FOOTER);
  const lastOf = (choices: readonly string[]) => Math.max(...choices.map((choice) => tail.lastIndexOf(choice)));
  const accept = tail.lastIndexOf('Yes,Iaccept');
  const trust = lastOf(CLAUDE_TRUST_CHOICES);
  const renderer = lastOf(CLAUDE_STARTUP_CHOICES.claude_fullscreen_renderer);
  const onboarding = lastOf(CLAUDE_ONBOARDING_TEXT);
  const latest = Math.max(accept, trust, renderer, onboarding);
  if (latest < 0) {
    if (!footer) return null;
    return tail.includes('No,exit') ? 'claude_bypass_permissions' : 'claude_startup_dialog_unidentified';
  }
  if (latest === onboarding) return 'claude_onboarding';
  if (latest === accept) return 'claude_bypass_permissions';
  // The trust dialog (#5108) is left to the trust detector while it reads it.
  if (latest === trust) {
    return detectTrustPrompt(paneLines(captured), ['claude_directory'])
      ? null
      : 'claude_startup_dialog_unidentified';
  }
  return footer ? 'claude_fullscreen_renderer' : 'claude_startup_dialog_unidentified';
}

// The trust dialog captured while Claude Code draws it (recorded on 2.1.330)
// or redraws it after Down: below the question, the last ❯ line is a choice
// cut short with at most the start of the next choice below it. The ready
// detector would read that ❯ line as an input box.
function claudeTrustDialogDrawing(lines: readonly string[]): boolean {
  const question = lines.findLastIndex((_, index) => claudeTrustQuestionStartsAt(lines, index));
  if (question < 0) return false;
  const below = lines.slice(question + 1);
  if (below.some((line) => /^(?:❯\s*)?Yes,\s*(?:proceed|I trust this folder)\b/i.test(line))) return false;
  const prompt = below.findLastIndex((line) => PANE_PATTERNS.claude.idlePromptLine.test(line));
  if (prompt < 0) return false;
  const drawn = squeeze(below[prompt]!.replace(PANE_PATTERNS.claude.idlePromptLine, ''));
  const after = below.slice(prompt + 1);
  const startsYes = (text: string) => CLAUDE_TRUST_CHOICES.some((choice) => choice.startsWith(text));
  // First drawn: "No, exit" is focused.
  if ('No,exit'.startsWith(drawn)) return after.length === 0 || (after.length === 1 && startsYes(squeeze(after[0]!)));
  // Redrawn after Down: "Yes" is focused below "No, exit", with or without its old ❯.
  return after.length === 0 && /^(?:❯\s*)?No,\s*exit$/i.test(below[prompt - 1] ?? '') && startsYes(drawn);
}

// Read only by the Claude startup wait, before it reads the trust dialogs.
export function detectClaudeStartupDialog(captured: string): ClaudeStartupDialogKind | null {
  return claudeStartupDialogIn(claudeDialogTail(captured), captured)
    ?? (claudeTrustDialogDrawing(paneLines(captured)) ? 'claude_startup_dialog_unidentified' : null);
}

function detectTrustPrompt(
  lines: readonly string[],
  kinds: readonly PaneTrustPromptKind[],
): PaneTrustPromptKind | null {
  const tail = lines.slice(-12);
  const tailHas = (pattern: RegExp) => tail.some((line) => pattern.test(line));

  if (kinds.includes('codex_directory') && codexTrustQuestionIsActive(lines)) {
    return 'codex_directory';
  }

  // cursor-agent asks the directory question but offers no selectable answer:
  // it prints "Workspace Trust Required", tells the operator to pass
  // --trust/-f, and exits. There is nothing to dismiss, so this is its own
  // kind and is never answered with keystrokes. Launch args carry `--force
  // --trust` precisely so this state is unreachable; seeing it means a pane
  // was started without them.
  if (
    kinds.includes('cursor_workspace_trust') &&
    tailHas(/Workspace Trust Required/i) &&
    (tailHas(/Pass\s+--trust,\s*--yolo,\s*or\s+-f/i) ||
      tailHas(/Do you trust the contents of this directory\?/i))
  ) {
    return 'cursor_workspace_trust';
  }

  // Claude Code wraps the question to the pane width. In a 35-column pane it
  // starts 13 lines from the bottom and reaches "trust?" within 3 lines.
  const claudeQuestionLines = lines.slice(-20);
  if (
    kinds.includes('claude_directory') &&
    claudeQuestionLines.some((_, index) => claudeTrustQuestionStartsAt(claudeQuestionLines, index)) &&
    tailHas(/\bNo,\s*exit\b/i) &&
    tailHas(/\bYes,\s*(?:proceed|I trust this folder)\b/i)
  ) {
    return 'claude_directory';
  }

  if (
    kinds.includes('directory') &&
    tailHas(/Do you trust the contents of this directory\?/i) &&
    tailHas(/Yes,\s*continue|No,\s*quit|Press enter to continue/i)
  ) {
    return 'directory';
  }

  if (
    kinds.includes('codex_hooks') &&
    tailHas(/Hooks need review/i) &&
    tailHas(/Continue without trusting/i) &&
    tailHas(/Press enter to confirm or esc to go back/i)
  ) {
    return 'codex_hooks';
  }

  return null;
}

// Claude Code v2.1.x keeps the permission-mode indicator ("⏵⏵ bypass
// permissions on (shift+tab to cycle)") drawn *below* the prompt while idle.
// With a prompt anywhere in the tail the pane has finished bootstrapping and
// the banner is an idle mode indicator, not a startup signal.
function hasStartupBanner(
  lines: readonly string[],
  patterns: ProviderPanePatterns,
): boolean {
  const tail = lines.slice(-20);
  if (tail.some((line) => patterns.idlePromptLine.test(line))) return false;
  return anyLineMatches(tail, patterns.startupBannerLines);
}

export function observePane(
  captured: string,
  provider?: CliAgentType,
): PaneSignals {
  const patterns = patternsFor(provider);
  const lines = paneLines(captured);
  const startupBanner = hasStartupBanner(lines, patterns);
  return {
    trust: detectTrustPrompt(lines, patterns.trustKinds),
    bootstrapping: startupBanner || anyLineMatches(lines, patterns.loadingLines),
    startupStatus: startupBanner || anyLineMatches(lines, patterns.startupStatusLines),
    idlePrompt: lines.some((line) => patterns.idlePromptLine.test(line)),
    busy: anyLineMatches(lines.slice(-40), patterns.busyLines),
  };
}

/**
 * One state for a pane, for decisions that send no keys themselves: whether the
 * idle nudge fires and what the monitor reports. Earlier states win, so a trust
 * dialog is never idle and a working pane is never idle. The checks that send
 * keys keep reading the signals the way they always have.
 */
export type PaneState =
  | { kind: 'trust'; trust: PaneTrustPromptKind }
  | { kind: 'busy' }
  | { kind: 'bootstrapping' }
  | { kind: 'idle' }
  | { kind: 'unknown' };

export function classifyPane(signals: PaneSignals): PaneState {
  if (signals.trust) return { kind: 'trust', trust: signals.trust };
  if (signals.busy) return { kind: 'busy' };
  if (signals.startupStatus) return { kind: 'bootstrapping' };
  if (signals.idlePrompt) return { kind: 'idle' };
  return { kind: 'unknown' };
}

export function detectPaneTrustPromptKind(
  captured: string,
  provider?: CliAgentType,
): PaneTrustPromptKind | null {
  return detectTrustPrompt(paneLines(captured), patternsFor(provider).trustKinds);
}

// Which choice of a Claude Code dialog is focused (marked with ❯). Claude Code
// draws "Yes" right below "No, exit" in its trust dialog; only the pair after
// the latest question is the live dialog. Null while that pair is not drawn
// yet; 'stale' when an input prompt is drawn below it.
export function claudeDialogFocus(
  captured: string,
  kind: ClaudeDialogKind,
): 'first' | 'second' | 'stale' | null {
  if (kind !== 'claude_directory') {
    const [first, second] = CLAUDE_STARTUP_CHOICES[kind];
    const tail = claudeDialogTail(captured);
    if (claudeStartupDialogIn(tail, captured) !== kind) {
      const stream = captured.replace(/\s+/g, '');
      return stream.includes(first) || stream.includes(second) ? 'stale' : null;
    }
    // The same dialog drawn before Down can remain above the latest copy, ❯
    // and footer included, so both are read below its latest heading only.
    const copy = tail.slice(Math.max(0, tail.lastIndexOf(CLAUDE_STARTUP_HEADINGS[kind])));
    const [firstAt, secondAt] = [copy.lastIndexOf(`❯${first}`), copy.lastIndexOf(`❯${second}`)];
    if ((firstAt < 0 && secondAt < 0) || !copy.includes(CLAUDE_DIALOG_FOOTER)) return null;
    return secondAt > firstAt ? 'second' : 'first';
  }
  const lines = paneLines(captured);
  const question = lines.findLastIndex((_, index) => claudeTrustQuestionStartsAt(lines, index));
  if (question < 0) return null;
  const no = lines.findIndex((line, index) => index > question && /^\s*(?:❯\s*)?No,\s*exit\b/i.test(line));
  const yes = no >= 0 ? lines[no + 1] ?? '' : '';
  if (!/^\s*(?:❯\s*)?Yes,\s*(?:proceed|I trust this folder)\b/i.test(yes)) return null;
  if (lines.slice(no + 2).some((line) => patternsFor('claude').idlePromptLine.test(line))) return 'stale';
  return /^\s*❯/.test(yes) ? 'second' : 'first';
}

export function paneHasTrustPrompt(
  captured: string,
  provider?: CliAgentType,
): boolean {
  return detectPaneTrustPromptKind(captured, provider) !== null;
}

export function paneHasStartupBanner(
  captured: string,
  provider?: CliAgentType,
): boolean {
  return hasStartupBanner(paneLines(captured), patternsFor(provider));
}

export function paneHasActiveTask(
  captured: string,
  provider?: CliAgentType,
): boolean {
  return anyLineMatches(
    paneLines(captured).slice(-40),
    patternsFor(provider).busyLines,
  );
}

export function paneLooksReady(
  captured: string,
  provider?: CliAgentType,
): boolean {
  const signals = observePane(captured, provider);
  // Dismissible trust prompts are still interactive. Cursor has exited, while
  // Codex's folder-trust choice must be made by the user, so neither is ready.
  if (
    signals.trust === 'cursor_workspace_trust' ||
    signals.trust === 'codex_directory'
  )
    return false;
  if (signals.trust) return true;
  if (signals.bootstrapping) return false;
  return signals.idlePrompt;
}
