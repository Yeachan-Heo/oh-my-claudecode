const LEGACY_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯]\s*/u;
const CURSOR_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯→]\s*/u;
const SHARED_BUSY_LINES = [
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
};
export const PANE_PATTERNS = {
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
const UNKNOWN_PROVIDER_PATTERNS = {
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
function patternsFor(provider) {
    if (provider === undefined)
        return UNKNOWN_PROVIDER_PATTERNS;
    return Object.hasOwn(PANE_PATTERNS, provider) ? PANE_PATTERNS[provider] : SHARED_PATTERNS;
}
function paneLines(captured) {
    return captured
        .split('\n')
        .map((line) => line.replace(/\r/g, '').trim())
        .filter((line) => line.length > 0);
}
function anyLineMatches(lines, patterns) {
    return lines.some((line) => patterns.some((pattern) => pattern.test(line)));
}
export function paneLineLooksLikeIdlePrompt(line, provider) {
    return patternsFor(provider).idlePromptLine.test(line);
}
function codexTrustQuestionIsActive(lines) {
    const codexPromptLine = PANE_PATTERNS.codex.idlePromptLine;
    const promptText = (line) => line.replace(codexPromptLine, '');
    const isTrustChoice = (text) => /^(?:1(?:\.|$)|2(?:\.|$))/i.test(text);
    const lastQuestionIndex = lines.findLastIndex((_, index) => /Trust this folder\?/i.test(lines.slice(index, index + 2).join(' ')));
    if (lastQuestionIndex < 0)
        return false;
    const lastPromptIndex = lines.findLastIndex((line) => codexPromptLine.test(line));
    if (lastPromptIndex < lastQuestionIndex)
        return true;
    const activePrompt = promptText(lines[lastPromptIndex]);
    if (isTrustChoice(activePrompt))
        return true;
    const previousChoiceWasRendered = lines
        .slice(lastQuestionIndex + 1, lastPromptIndex)
        .some((line) => isTrustChoice(promptText(line)));
    return activePrompt === '' && !previousChoiceWasRendered;
}
// True when the question, wrapped over at most 3 lines, is in the lines from index on.
function claudeTrustQuestionStartsAt(lines, index) {
    return /(?:Do you trust the files in this folder|Quick safety check:\s*Is this a project you created or one you trust)\?/i.test(lines.slice(index, index + 3).join(' '));
}
// Every dialog is read from the capture with all whitespace removed, so how
// the pane wraps it (Claude Code at a space, tmux mid-word, a choice split over
// two lines) cannot hide it. A short pane with no scrollback can also lose the
// dialog's top, so any part of one counts: a dialog seen in part gets no
// trigger and no Enter.
const CLAUDE_STARTUP_CHOICES = {
    claude_bypass_permissions: ['No,exit', 'Yes,Iaccept'],
    claude_fullscreen_renderer: ['1.Yes,tryit', '2.Notnow'],
};
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
};
const CLAUDE_CHOICES = [
    ...Object.values(CLAUDE_STARTUP_CHOICES).flat(),
    ...CLAUDE_TRUST_CHOICES,
    ...CLAUDE_THEME_CHOICES,
];
const squeeze = (text) => text.replace(/\s+/g, '');
// A line the ready detector reads as an input prompt can instead be a dialog
// choice focused with ❯ (a theme choice also with ✔), wrapped over the next
// lines in a narrow pane. It is a choice only if the line holds nothing else.
function lineMarksClaudeChoice(lines, index) {
    const rest = squeeze(lines[index].replace(PANE_PATTERNS.claude.idlePromptLine, '')).replace(/^✔/u, '');
    if (!rest)
        return false;
    const drawn = rest + squeeze(lines.slice(index + 1, index + 4).join(''));
    return CLAUDE_CHOICES.some((choice) => choice.startsWith(rest) && drawn.startsWith(choice));
}
// The squeezed capture below the last live input prompt, as the ready detector
// reads prompts (❯, ›, >), not counting a focused dialog choice. A dialog quoted
// above that prompt is not on screen. What sits below it is always read, the
// HUD included: a screen missed here could get the trigger and Enter, while one
// read wrongly only stops the start.
function claudeDialogTail(captured) {
    const lines = paneLines(captured);
    const prompt = lines.findLastIndex((line, index) => PANE_PATTERNS.claude.idlePromptLine.test(line) && !lineMarksClaudeChoice(lines, index));
    return squeeze(lines.slice(prompt + 1).join(''));
}
// The dialog whose choice (or onboarding text) is drawn last is the live one:
// an answered dialog can remain above it. "No, exit" alone is the bypass warning only with the
// footer, as the trust dialog draws it too.
function claudeStartupDialogIn(tail, captured) {
    const footer = tail.includes(CLAUDE_DIALOG_FOOTER);
    const lastOf = (choices) => Math.max(...choices.map((choice) => tail.lastIndexOf(choice)));
    const accept = tail.lastIndexOf('Yes,Iaccept');
    const trust = lastOf(CLAUDE_TRUST_CHOICES);
    const renderer = lastOf(CLAUDE_STARTUP_CHOICES.claude_fullscreen_renderer);
    const onboarding = lastOf(CLAUDE_ONBOARDING_TEXT);
    const latest = Math.max(accept, trust, renderer, onboarding);
    if (latest < 0) {
        if (!footer)
            return null;
        return tail.includes('No,exit') ? 'claude_bypass_permissions' : 'claude_startup_dialog_unidentified';
    }
    if (latest === onboarding)
        return 'claude_onboarding';
    if (latest === accept)
        return 'claude_bypass_permissions';
    // The trust dialog (#5108) is left to the trust detector while it reads it.
    if (latest === trust) {
        return detectTrustPrompt(paneLines(captured), ['claude_directory'])
            ? null
            : 'claude_startup_dialog_unidentified';
    }
    return footer ? 'claude_fullscreen_renderer' : 'claude_startup_dialog_unidentified';
}
// Read only by the Claude startup wait, before it reads the trust dialogs.
export function detectClaudeStartupDialog(captured) {
    return claudeStartupDialogIn(claudeDialogTail(captured), captured);
}
function detectTrustPrompt(lines, kinds) {
    const tail = lines.slice(-12);
    const tailHas = (pattern) => tail.some((line) => pattern.test(line));
    if (kinds.includes('codex_directory') && codexTrustQuestionIsActive(lines)) {
        return 'codex_directory';
    }
    // cursor-agent asks the directory question but offers no selectable answer:
    // it prints "Workspace Trust Required", tells the operator to pass
    // --trust/-f, and exits. There is nothing to dismiss, so this is its own
    // kind and is never answered with keystrokes. Launch args carry `--force
    // --trust` precisely so this state is unreachable; seeing it means a pane
    // was started without them.
    if (kinds.includes('cursor_workspace_trust') &&
        tailHas(/Workspace Trust Required/i) &&
        (tailHas(/Pass\s+--trust,\s*--yolo,\s*or\s+-f/i) ||
            tailHas(/Do you trust the contents of this directory\?/i))) {
        return 'cursor_workspace_trust';
    }
    // Claude Code wraps the question to the pane width. In a 35-column pane it
    // starts 13 lines from the bottom and reaches "trust?" within 3 lines.
    const claudeQuestionLines = lines.slice(-20);
    if (kinds.includes('claude_directory') &&
        claudeQuestionLines.some((_, index) => claudeTrustQuestionStartsAt(claudeQuestionLines, index)) &&
        tailHas(/\bNo,\s*exit\b/i) &&
        tailHas(/\bYes,\s*(?:proceed|I trust this folder)\b/i)) {
        return 'claude_directory';
    }
    if (kinds.includes('directory') &&
        tailHas(/Do you trust the contents of this directory\?/i) &&
        tailHas(/Yes,\s*continue|No,\s*quit|Press enter to continue/i)) {
        return 'directory';
    }
    if (kinds.includes('codex_hooks') &&
        tailHas(/Hooks need review/i) &&
        tailHas(/Continue without trusting/i) &&
        tailHas(/Press enter to confirm or esc to go back/i)) {
        return 'codex_hooks';
    }
    return null;
}
// Claude Code v2.1.x keeps the permission-mode indicator ("⏵⏵ bypass
// permissions on (shift+tab to cycle)") drawn *below* the prompt while idle.
// With a prompt anywhere in the tail the pane has finished bootstrapping and
// the banner is an idle mode indicator, not a startup signal.
function hasStartupBanner(lines, patterns) {
    const tail = lines.slice(-20);
    if (tail.some((line) => patterns.idlePromptLine.test(line)))
        return false;
    return anyLineMatches(tail, patterns.startupBannerLines);
}
export function observePane(captured, provider) {
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
export function classifyPane(signals) {
    if (signals.trust)
        return { kind: 'trust', trust: signals.trust };
    if (signals.busy)
        return { kind: 'busy' };
    if (signals.startupStatus)
        return { kind: 'bootstrapping' };
    if (signals.idlePrompt)
        return { kind: 'idle' };
    return { kind: 'unknown' };
}
export function detectPaneTrustPromptKind(captured, provider) {
    return detectTrustPrompt(paneLines(captured), patternsFor(provider).trustKinds);
}
// Which choice of a Claude Code dialog is focused (marked with ❯). Claude Code
// draws "Yes" right below "No, exit" in its trust dialog; only the pair after
// the latest question is the live dialog. Null while that pair is not drawn
// yet; 'stale' when an input prompt is drawn below it.
export function claudeDialogFocus(captured, kind) {
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
        if ((firstAt < 0 && secondAt < 0) || !copy.includes(CLAUDE_DIALOG_FOOTER))
            return null;
        return secondAt > firstAt ? 'second' : 'first';
    }
    const lines = paneLines(captured);
    const question = lines.findLastIndex((_, index) => claudeTrustQuestionStartsAt(lines, index));
    if (question < 0)
        return null;
    const no = lines.findIndex((line, index) => index > question && /^\s*(?:❯\s*)?No,\s*exit\b/i.test(line));
    const yes = no >= 0 ? lines[no + 1] ?? '' : '';
    if (!/^\s*(?:❯\s*)?Yes,\s*(?:proceed|I trust this folder)\b/i.test(yes))
        return null;
    if (lines.slice(no + 2).some((line) => patternsFor('claude').idlePromptLine.test(line)))
        return 'stale';
    return /^\s*❯/.test(yes) ? 'second' : 'first';
}
export function paneHasTrustPrompt(captured, provider) {
    return detectPaneTrustPromptKind(captured, provider) !== null;
}
export function paneHasStartupBanner(captured, provider) {
    return hasStartupBanner(paneLines(captured), patternsFor(provider));
}
export function paneHasActiveTask(captured, provider) {
    return anyLineMatches(paneLines(captured).slice(-40), patternsFor(provider).busyLines);
}
export function paneLooksReady(captured, provider) {
    const signals = observePane(captured, provider);
    // Dismissible trust prompts are still interactive. Cursor has exited, while
    // Codex's folder-trust choice must be made by the user, so neither is ready.
    if (signals.trust === 'cursor_workspace_trust' ||
        signals.trust === 'codex_directory')
        return false;
    if (signals.trust)
        return true;
    if (signals.bootstrapping)
        return false;
    return signals.idlePrompt;
}
//# sourceMappingURL=pane-readiness.js.map