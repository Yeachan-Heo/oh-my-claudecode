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

// Claude Code marks the focused choice of its trust dialog with ❯ and draws
// "Yes" right below "No, exit". Only the pair after the latest question is the
// live dialog: an answered dialog can remain in the scrollback above it. Null
// while that pair is not drawn yet; 'stale' when an input prompt is drawn
// below it, so keys would reach that prompt instead of the dialog.
export function claudeTrustFocus(captured: string): 'no' | 'yes' | 'stale' | null {
  const lines = paneLines(captured);
  const question = lines.findLastIndex((_, index) => claudeTrustQuestionStartsAt(lines, index));
  if (question < 0) return null;
  const no = lines.findIndex((line, index) => index > question && /^\s*(?:❯\s*)?No,\s*exit\b/i.test(line));
  const yes = no >= 0 ? lines[no + 1] ?? '' : '';
  if (!/^\s*(?:❯\s*)?Yes,\s*(?:proceed|I trust this folder)\b/i.test(yes)) return null;
  if (lines.slice(no + 2).some((line) => patternsFor('claude').idlePromptLine.test(line))) return 'stale';
  return /^\s*❯/.test(yes) ? 'yes' : 'no';
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
