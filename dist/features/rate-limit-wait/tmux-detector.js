/**
 * tmux Detector
 *
 * Detects Claude Code sessions running in tmux panes and identifies
 * those that are blocked due to rate limiting.
 *
 * Security considerations:
 * - Pane IDs are validated before use in shell commands
 * - Text inputs are sanitized to prevent command injection
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmuxExec, tmuxSpawn } from '../../cli/tmux-utils.js';
import { getNewPaneTail } from './pane-fresh-capture.js';
import { captureHerdrWorkerPane, herdrSendKey, listHerdrAgents, herdrWorkspaceIdFromPaneId, } from '../../team/herdr-session.js';
import { isHerdrPaneId, paneCurrentCommandLooksReady, privateTmuxSocketDirectory, resolveTeamMultiplexer } from '../../team/tmux-session.js';
/**
 * Validate tmux pane ID format to prevent command injection
 * Valid formats: %0, %1, %123, etc.
 */
function isValidPaneId(paneId) {
    return /^%\d+$/.test(paneId);
}
/**
 * Sanitize text for use in tmux send-keys command
 * Escapes single quotes to prevent command injection
 */
function sanitizeForTmux(text) {
    // Escape single quotes by ending the quote, adding escaped quote, and reopening
    return text.replace(/'/g, "'\\''");
}
/** Rate limit message patterns to detect in pane content */
const RATE_LIMIT_PATTERNS = [
    /rate limit/i,
    /usage limit/i,
    /quota exceeded/i,
    /too many requests/i,
    /please wait/i,
    /try again later/i,
    /limit reached/i,
    /hit your limit/i,
    /hit .+ limit/i,
    /resets? .+ at/i,
    /5[- ]?hour/i,
    // Require adjacent rate-limit vocabulary to avoid false-positives from git commit
    // messages or documentation that contain the bare word "weekly" (e.g. "fix weekly
    // report generation", "update weekly standup notes").
    /\bweekly\s+(?:usage\s+)?(?:limit|quota|cap|allowance|allocation)\b/i,
];
/** Patterns that indicate Claude Code is running outside the OMC HUD */
const CLAUDE_CODE_PATTERNS = [
    /claude/i,
    /anthropic/i,
    /\$ claude/,
    /claude code/i,
    /conversation/i,
    /assistant/i,
];
/** Anchored OMC HUD status line, not copied output embedded in logs/tests. */
const OMC_HUD_STATUS_LINE_PATTERN = /^\s*\[OMC#[^\]\s]+\](?:\s*\|.*)?\s*$/i;
/** OMC HUD mode/help line rendered in the captured UI footer. */
const OMC_HUD_MODE_LINE_PATTERN = /^\s*⏵⏵\s+.*\(shift\+tab to cycle\)/i;
/** Shell commands that print saved terminal transcripts rather than a live UI. */
const SAVED_TRANSCRIPT_COMMAND_PATTERN = /^\s*(?:[$#%]|❯)\s*(?:cat|bat|less|more|tail|head|sed|awk)\b.*(?:hud|transcript|terminal|output|copied|\.txt)\b/i;
/** Plain-language labels commonly pasted above copied terminal/HUD output. */
const SAVED_TRANSCRIPT_LABEL_PATTERN = /\b(?:copied\s+from|saved\s+terminal\s+output|terminal\s+transcript|copied\s+hud)\b/i;
/** Rate-limit text shown by the live Claude/OMC limit screen, not arbitrary API/log output. */
const OMC_HUD_RATE_LIMIT_SCREEN_PATTERNS = [
    /you(?:'|’)ve\s+(?:hit|reached)\s+(?:your\s+)?(?:session\s+|usage\s+)?limit/i,
    /\b(?:session|usage|weekly|5[- ]?hour)\s+(?:usage\s+)?(?:limit|quota|cap|allowance|allocation)\b/i,
    /\blimit\s+resets?\b/i,
    /stop\s+and\s+wait\s+for\s+limit\s+to\s+reset/i,
];
function hasOmcRateLimitScreenText(content) {
    return OMC_HUD_RATE_LIMIT_SCREEN_PATTERNS.some(pattern => pattern.test(content));
}
function hasSavedTranscriptContext(content) {
    return content
        .split('\n')
        .some(line => SAVED_TRANSCRIPT_COMMAND_PATTERN.test(line) ||
        SAVED_TRANSCRIPT_LABEL_PATTERN.test(line));
}
function hasLiveOmcHudEvidence(content) {
    if (hasSavedTranscriptContext(content)) {
        return false;
    }
    const nonEmptyLines = content
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim().length > 0);
    const hudStatusIndex = nonEmptyLines.findIndex(line => OMC_HUD_STATUS_LINE_PATTERN.test(line));
    if (hudStatusIndex === -1) {
        return false;
    }
    const modeLineIndex = nonEmptyLines.findIndex((line, index) => index > hudStatusIndex && OMC_HUD_MODE_LINE_PATTERN.test(line));
    if (modeLineIndex === -1) {
        return false;
    }
    const isFooterBlock = hudStatusIndex >= nonEmptyLines.length - 4 &&
        modeLineIndex === nonEmptyLines.length - 1 &&
        modeLineIndex - hudStatusIndex <= 2;
    return isFooterBlock;
}
/**
 * Tightened weekly rate-limit pattern, extracted so `analyzePaneContent` can
 * use the same predicate for `rateLimitType` classification.
 */
const WEEKLY_RATE_LIMIT_PATTERN = /\bweekly\s+(?:usage\s+)?(?:limit|quota|cap|allowance|allocation)\b/i;
/**
 * Line-level patterns that identify `git log` / `git show` / `git diff` output.
 * These lines are stripped before rate-limit pattern matching to prevent commit
 * messages from producing false-positive "weekly / assistant / conversation" hits.
 */
const GIT_OUTPUT_LINE_PATTERNS = [
    /^commit\s+[0-9a-f]{6,40}\b/, // git log commit hash
    /^Author:\s+\S/, // git log author
    /^Date:\s+\S/, // git log date
    /^Merge:\s+[0-9a-f]{6,}/, // git log merge line
    /^diff\s+--git\s+a\//, // git diff header
    /^(?:---|\+\+\+)\s+[ab]\//, // git diff file paths
    /^@@\s+-\d+/, // git diff hunk header
];
/**
 * Strip lines that are clearly `git log` / `git diff` output so that commit
 * message text (e.g. "Fix weekly report", "Update assistant config") cannot
 * trigger rate-limit keyword patterns.
 */
function stripGitOutputLines(content) {
    return content
        .split('\n')
        .filter(line => !GIT_OUTPUT_LINE_PATTERNS.some(p => p.test(line.trimStart())))
        .join('\n');
}
/** Patterns that indicate the pane is waiting for user input */
const WAITING_PATTERNS = [
    /\[\d+\]/, // Menu selection prompt like [1], [2], [3]
    /^\s*❯?\s*\d+\.\s/m, // Menu selection prompt like "❯ 1. ..." or "  2. ..."
    /continue\?/i, // Continue prompt
    /press enter/i,
    /waiting for/i,
    /select an option/i,
    /choice:/i,
    /enter to confirm/i,
];
/** The first menu option must still offer an actionable continuation. */
const LIVE_RESUME_OPTION_PATTERN = /^\s*(?:❯\s*)?(?:\[1\]|1[.)]?)\s+(?:continue|resume|retry|try again|stop and wait|wait and continue automatically)\b/im;
const LIVE_CONFIRMATION_PROMPT_PATTERN = /^\s*(?:enter to confirm(?:\s*·\s*esc to cancel)?|enter choice:)\s*$/i;
const LIVE_MENU_OPTION_PATTERN = /^\s*(?:❯\s*)?(?:\[\d+\]|\d+[.)]?)\s+/;
const LIVE_MENU_QUESTION_PATTERN = /^\s*what (?:would you like|do you want) to do\?\s*$/i;
const LIVE_MENU_DIVIDER_PATTERN = /^\s*[-─━═]+\s*$/;
const LIVE_MENU_LABEL_PATTERN = /^\s*options:\s*$/i;
function isLiveMenuContextSeparator(line) {
    return LIVE_MENU_DIVIDER_PATTERN.test(line) || LIVE_MENU_LABEL_PATTERN.test(line);
}
function hasLiveResumeMenuPrompt(lines) {
    const lastLine = lines.at(-1) ?? '';
    const hasConfirmation = LIVE_CONFIRMATION_PROMPT_PATTERN.test(lastLine);
    if (!hasConfirmation && !LIVE_RESUME_OPTION_PATTERN.test(lastLine))
        return false;
    let firstOptionIndex = lines.length - (hasConfirmation ? 2 : 1);
    if (firstOptionIndex < 0 || !LIVE_MENU_OPTION_PATTERN.test(lines[firstOptionIndex] ?? '')) {
        return false;
    }
    while (firstOptionIndex > 0 && LIVE_MENU_OPTION_PATTERN.test(lines[firstOptionIndex - 1] ?? '')) {
        firstOptionIndex--;
    }
    if (!LIVE_RESUME_OPTION_PATTERN.test(lines[firstOptionIndex] ?? ''))
        return false;
    let contextIndex = firstOptionIndex - 1;
    while (contextIndex >= 0 && isLiveMenuContextSeparator(lines[contextIndex] ?? '')) {
        contextIndex--;
    }
    if (contextIndex >= 0 && RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(lines[contextIndex] ?? ''))) {
        return true;
    }
    if (contextIndex >= 0 && LIVE_MENU_QUESTION_PATTERN.test(lines[contextIndex] ?? '')) {
        contextIndex--;
        while (contextIndex >= 0 && isLiveMenuContextSeparator(lines[contextIndex] ?? '')) {
            contextIndex--;
        }
        return contextIndex >= 0 && RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(lines[contextIndex] ?? ''));
    }
    return false;
}
function hasLiveWaitAndContinuePrompt(lines) {
    const promptIndex = lines.length - 1;
    if ((lines[promptIndex] ?? '').trim() !== '>')
        return false;
    let firstOptionIndex = promptIndex - 1;
    while (firstOptionIndex >= 0 && LIVE_MENU_OPTION_PATTERN.test(lines[firstOptionIndex] ?? '')) {
        firstOptionIndex--;
    }
    firstOptionIndex++;
    if (firstOptionIndex >= promptIndex ||
        !LIVE_RESUME_OPTION_PATTERN.test(lines[firstOptionIndex] ?? '') ||
        !lines.slice(firstOptionIndex, promptIndex).every((line) => LIVE_MENU_OPTION_PATTERN.test(line))) {
        return false;
    }
    let questionIndex = firstOptionIndex - 1;
    while (questionIndex >= 0 && isLiveMenuContextSeparator(lines[questionIndex] ?? '')) {
        questionIndex--;
    }
    if (questionIndex < 0 || !LIVE_MENU_QUESTION_PATTERN.test(lines[questionIndex] ?? '')) {
        return false;
    }
    let contextLinesChecked = 0;
    for (let contextIndex = questionIndex - 1; contextIndex >= 0 && contextLinesChecked < 3; contextIndex--) {
        const line = lines[contextIndex] ?? '';
        if (isLiveMenuContextSeparator(line))
            continue;
        contextLinesChecked++;
        if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(line)))
            return true;
    }
    return false;
}
/**
 * Check if tmux is installed and available.
 * On Windows, a tmux-compatible binary such as psmux may provide tmux.
 */
export function isTmuxAvailable() {
    try {
        const result = tmuxSpawn(['-V'], { stripTmux: true, stdio: 'pipe', timeout: 3000 });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
/**
 * Check if currently running inside a tmux session
 */
export function isInsideTmux() {
    return !!process.env.TMUX;
}
function parseTmuxPanes(result) {
    const panes = [];
    for (const line of result.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        // Session names may contain spaces; tmux replaces ':' with '_' in names.
        const match = line.match(/^([^:]*):(\d+)\.(\d+) (%\d+) ([01]) (.*)$/);
        if (!match)
            continue;
        const [, session, windowIndexStr, paneIndexStr, paneId, activeStr, rest] = match;
        const [windowName, ...titleParts] = rest.split(' ');
        panes.push({
            id: paneId,
            session,
            windowIndex: parseInt(windowIndexStr, 10),
            windowName,
            paneIndex: parseInt(paneIndexStr, 10),
            title: titleParts.join(' ') || undefined,
            isActive: activeStr === '1',
        });
    }
    return panes;
}
// A tmux call on a private endpoint (`-S <socket>`), or on the default server when no socket is given.
function onSocket(socket, args) {
    return socket === undefined ? args : ['-S', socket, ...args];
}
// A failed call that says for certain that there is no server to talk to (not started, exited, socket file left
// behind): its panes are gone. Any other connection failure (permissions, a timeout) says nothing about the panes.
function isNoServerError(error) {
    const failure = error;
    const text = `${String(failure?.message ?? '')} ${String(failure?.stderr ?? '')}`;
    return /no server running|error connecting to .*\((?:No such file or directory|Connection refused)\)/i.test(text);
}
// The guard that binds a command to the tmux server that listed a pane: a pane id is reused after a server restart, so the
// condition is evaluated by the server itself, in the same step as the command, against the pid and start time that the
// listing returned. When it does not hold, the command is not run and the marker is printed instead. Without a server
// value (a listing that carries none) the command is not guarded.
const SERVER_VALUE = /^\d+:\d+$/;
const PLAIN_TMUX_WORD = /^[A-Za-z0-9_.%:@+=,-]+$/;
function tmuxWord(word) {
    return PLAIN_TMUX_WORD.test(word) ? word : `"${word.replace(/[\\"$]/g, '\\$&')}"`;
}
/**
 * The tmux arguments for `command`, on the endpoint `socket` and, with `server`, only while that server is the one that
 * listed the pane (see above). `marker` is what the call prints when the guard does not hold; null when not guarded.
 * Null when `server` is not a pid and start time.
 */
function tmuxCall(socket, server, command) {
    if (server === undefined)
        return { args: onSocket(socket, command), marker: null };
    if (!SERVER_VALUE.test(server))
        return null;
    const marker = `OMC_QUOTA_GUARD_FAIL_${randomBytes(6).toString('hex')}`;
    return {
        args: onSocket(socket, ['if-shell', '-F', `#{==:#{pid}:#{start_time},${server}}`, command.map(tmuxWord).join(' '), `display-message -p ${marker}`]),
        marker,
    };
}
/**
 * Lists the panes of one tmux server: the default one, or the private endpoint `socket`. Returns 'absent' when that
 * server is not running, and null when its inventory cannot be read.
 */
function listPanesAt(socket, withServer) {
    try {
        // Format: [pid:start_time ]session_name:window_index.pane_index pane_id pane_active window_name pane_title
        const format = (withServer ? '#{pid}:#{start_time} ' : '')
            + '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_active} #{window_name} #{pane_title}';
        const result = tmuxExec(onSocket(socket, ['list-panes', '-a', '-F', format]), {
            stripTmux: true,
            timeout: 5000,
        });
        if (withServer) {
            const panes = [];
            for (const line of result.split(/\r?\n/)) {
                if (!line.trim())
                    continue;
                const split = line.indexOf(' ');
                const server = line.slice(0, split);
                if (!/^\d+:\d+$/.test(server))
                    return null;
                for (const pane of parseTmuxPanes(line.slice(split + 1)))
                    panes.push({ ...pane, server });
            }
            return panes;
        }
        return parseTmuxPanes(result);
    }
    catch (error) {
        if (isNoServerError(error))
            return 'absent';
        console.error('[TmuxDetector] Error listing panes:', error);
        return null;
    }
}
/**
 * With `withServer`, every line also carries the server's pid and start time, and each pane gets them as `server`: a
 * pane id is unique only within one run of the tmux server. A listing whose lines do not all carry that value is
 * reported as unreadable (null), because the caller asked for a binding it could then not make.
 */
export function listTmuxPanesStrict(withServer = false) {
    if (!isTmuxAvailable()) {
        return null;
    }
    const panes = listPanesAt(undefined, withServer);
    return panes === 'absent' ? null : panes;
}
const PRIVATE_SOCKET_NAME = /^o-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{8}\.sock$/;
/**
 * The private tmux endpoints that `omc team` creates when it starts without a default server (see
 * buildPrivateTmuxSocketPath): sockets of this user in the private socket directory. An entry that is gone by the time
 * it is examined is skipped; null when the directory or an entry cannot be examined for any other reason, because a
 * shorter list would be taken for the whole inventory.
 */
function privateTmuxSockets() {
    if (process.platform === 'win32')
        return [];
    const directory = privateTmuxSocketDirectory();
    let names;
    try {
        names = readdirSync(directory);
    }
    catch (error) {
        return error?.code === 'ENOENT' ? [] : null;
    }
    const sockets = [];
    for (const name of names) {
        if (!PRIVATE_SOCKET_NAME.test(name))
            continue;
        const path = join(directory, name);
        try {
            const stat = lstatSync(path);
            if (stat.isSocket() && stat.uid === process.getuid?.())
                sockets.push(path);
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                return null;
        }
    }
    return sockets;
}
/**
 * The endpoint of the tmux server that this process was started from: the socket path in `TMUX` (`<socket>,<pid>,<index>`).
 * `omc team` started inside a tmux server uses that server, whatever its socket is called. Null when there is none or it
 * is not an absolute path.
 */
function ambientTmuxSocket() {
    const socket = (process.env.TMUX ?? '').split(',')[0] ?? '';
    return socket.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(socket) ? socket : null;
}
/**
 * The panes of the default server, of the server this process was started from, and of every private endpoint, each
 * pane of a non-default endpoint carrying its `socket`. A server that is not running adds nothing; a server whose
 * inventory cannot be read makes the whole inventory unreadable, and so does a machine where no server is running at
 * all. A server reached by two endpoints (the default one that is also the ambient one) is listed once.
 */
function listPanelQuotaPanes() {
    if (!isTmuxAvailable()) {
        return null;
    }
    const panes = [];
    const listedServers = new Set();
    let running = 0;
    const privateSockets = privateTmuxSockets();
    if (privateSockets === null)
        return null;
    const ambient = ambientTmuxSocket();
    const sockets = [...new Set([...privateSockets, ...(ambient === null ? [] : [ambient])])];
    for (const socket of [undefined, ...sockets]) {
        const listed = listPanesAt(socket, true);
        if (listed === null)
            return null;
        if (listed === 'absent')
            continue;
        running++;
        if (listed.length > 0 && listed.every((pane) => pane.server !== undefined && listedServers.has(pane.server)))
            continue;
        for (const pane of listed)
            if (pane.server !== undefined)
                listedServers.add(pane.server);
        panes.push(...(socket === undefined ? listed : listed.map((pane) => ({ ...pane, socket }))));
    }
    return running > 0 ? panes : null;
}
/**
 * List all tmux panes across all sessions.
 */
export function listTmuxPanes() {
    return listTmuxPanesStrict() ?? [];
}
/**
 * Check whether a tmux pane is alive (not in the dead/exited state).
 *
 * tmux sets #{pane_dead} to "1" once the child process in the pane exits.
 * Capturing content from a dead pane returns stale scrollback and can
 * trigger spurious keyword alerts — callers should skip capture when this
 * returns false.
 *
 * Returns false for dead panes, invalid pane IDs, and when tmux is unavailable.
 * Intentionally synchronous so it can be used in fire-and-forget hook paths.
 */
export function isPaneAlive(paneId) {
    if (!isTmuxAvailable()) {
        return false;
    }
    if (!isValidPaneId(paneId)) {
        return false;
    }
    try {
        const result = tmuxExec(['display-message', '-t', paneId, '-p', '#{pane_dead}'], { stripTmux: true, stdio: 'pipe', timeout: 3000 });
        return result.trim() === '0';
    }
    catch {
        // pane gone or session dead — treat as not alive
        return false;
    }
}
/**
 * Capture the content of a specific tmux pane
 *
 * @param paneId - The tmux pane ID (e.g., "%0")
 * @param lines - Number of lines to capture (default: 15)
 */
function capturePaneContentStrict(paneId, lines, socket, server) {
    if (!isTmuxAvailable()) {
        return null;
    }
    // Herdr panes (wN:pM) belong to the herdr arm below, not to tmux.
    if (isHerdrPaneId(paneId)) {
        return null;
    }
    // Validate pane ID to prevent command injection
    if (!isValidPaneId(paneId)) {
        console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
        return null;
    }
    // Validate lines is a reasonable positive integer
    const safeLines = Math.max(1, Math.min(100, Math.floor(lines)));
    try {
        // Capture the last N lines from the pane
        const call = tmuxCall(socket, server, ['capture-pane', '-t', paneId, '-p', '-S', `-${safeLines}`]);
        if (call === null)
            return null;
        const result = tmuxExec(call.args, {
            stripTmux: true,
            timeout: 5000,
        });
        // A server that is not the one that listed the pane has another pane under this id: nothing of it is read.
        if (call.marker !== null && result.includes(call.marker))
            return null;
        return result;
    }
    catch (error) {
        console.error(`[TmuxDetector] Error capturing pane ${paneId}:`, error);
        return null;
    }
}
export function capturePaneContent(paneId, lines = 15) {
    return capturePaneContentStrict(paneId, lines) ?? '';
}
/**
 * Analyze pane content to determine if it shows a rate-limited Claude Code session
 */
export function analyzePaneContent(content) {
    if (!content.trim()) {
        return {
            hasClaudeCode: false,
            hasRateLimitMessage: false,
            isBlocked: false,
            confidence: 0,
        };
    }
    // Strip git log / diff lines so commit message text (e.g. "Fix weekly report",
    // "Update assistant config") cannot produce false-positive keyword matches.
    const cleanedContent = stripGitOutputLines(content);
    // Check for Claude Code indicators. OMC HUD footer evidence only counts as a
    // Claude pane when paired with live limit-screen wording; copied HUD footers
    // next to unrelated API/log rate-limit text must not impersonate a blocked pane.
    const hasClaudeText = CLAUDE_CODE_PATTERNS.some((pattern) => pattern.test(cleanedContent));
    const hasLiveOmcHud = hasLiveOmcHudEvidence(cleanedContent);
    const hasClaudeCode = hasClaudeText || (hasLiveOmcHud && hasOmcRateLimitScreenText(cleanedContent));
    // Check for rate limit messages
    const rateLimitMatches = RATE_LIMIT_PATTERNS.filter((pattern) => pattern.test(cleanedContent));
    const hasRateLimitMessage = rateLimitMatches.length > 0;
    // Check if waiting for user input
    const isWaiting = WAITING_PATTERNS.some((pattern) => pattern.test(cleanedContent));
    // Determine rate limit type
    let rateLimitType;
    if (hasRateLimitMessage) {
        if (/5[- ]?hour/i.test(cleanedContent)) {
            rateLimitType = 'five_hour';
        }
        else if (WEEKLY_RATE_LIMIT_PATTERN.test(cleanedContent)) {
            rateLimitType = 'weekly';
        }
        else {
            rateLimitType = 'unknown';
        }
    }
    // Calculate confidence
    let confidence = 0;
    if (hasClaudeCode)
        confidence += 0.4;
    if (hasRateLimitMessage)
        confidence += 0.4;
    if (isWaiting)
        confidence += 0.2;
    if (rateLimitMatches.length > 1)
        confidence += 0.1; // Multiple matches = higher confidence
    // Determine if blocked
    const isBlocked = hasClaudeCode && hasRateLimitMessage && confidence >= 0.6;
    return {
        hasClaudeCode,
        hasRateLimitMessage,
        isBlocked,
        rateLimitType,
        confidence: Math.min(1, confidence),
    };
}
/**
 * Scan all tmux panes for blocked Claude Code sessions.
 *
 * @param lines    - Number of lines to capture from each pane
 * @param stateDir - When provided, use cursor-tracked capture (getNewPaneTail) so
 *                   repeated daemon polls only surface lines written since the last
 *                   scan. Panes with no new output are skipped, preventing stale
 *                   rate-limit messages from re-alerting after blockers are resolved.
 *                   When omitted, falls back to a plain capturePaneContent call.
 */
export function scanForBlockedPanes(lines = 15, stateDir) {
    const panes = listTmuxPanes();
    const blocked = [];
    for (const pane of panes) {
        let content;
        if (stateDir) {
            // Cursor-tracked: only lines appended since the last scan are returned.
            // An empty result means nothing new — skip to avoid stale re-alerts.
            content = getNewPaneTail(pane.id, stateDir, lines);
            if (!content)
                continue;
        }
        else {
            content = capturePaneContent(pane.id, lines);
        }
        const analysis = analyzePaneContent(content);
        if (analysis.isBlocked) {
            blocked.push({
                ...pane,
                analysis,
                firstDetectedAt: new Date(),
                resumeAttempted: false,
            });
        }
    }
    return blocked;
}
/**
 * Revalidate persisted pane candidates before sending resume keys.
 * Returns null when tmux could not provide a complete scan, so callers can retry
 * without discarding recovery state. A successful scan only returns panes whose
 * current output still shows a rate-limit screen and a live first resume option.
 */
export function revalidateBlockedPanes(trackedPanes, lines = 15) {
    if (trackedPanes.length === 0)
        return [];
    const livePanes = listTmuxPanesStrict();
    if (livePanes === null)
        return null;
    const resumable = [];
    for (const tracked of trackedPanes) {
        if (!isValidPaneId(tracked.id))
            continue;
        const current = livePanes.find((pane) => pane.id === tracked.id &&
            pane.session === tracked.session &&
            pane.windowIndex === tracked.windowIndex &&
            pane.paneIndex === tracked.paneIndex);
        if (!current)
            continue;
        const content = capturePaneContentStrict(current.id, lines);
        if (content === null)
            return null;
        const analysis = analyzePaneContent(content);
        const recentLines = content
            .split(/\r?\n/)
            .filter((line) => line.trim() &&
            !OMC_HUD_STATUS_LINE_PATTERN.test(line) &&
            !OMC_HUD_MODE_LINE_PATTERN.test(line))
            .join('\n');
        const recentLineList = recentLines.split('\n');
        const hasLivePrompt = hasLiveResumeMenuPrompt(recentLineList) ||
            hasLiveWaitAndContinuePrompt(recentLineList);
        if (!analysis.isBlocked ||
            !LIVE_RESUME_OPTION_PATTERN.test(recentLines) ||
            !hasLivePrompt)
            continue;
        resumable.push({
            ...current,
            analysis,
            firstDetectedAt: tracked.firstDetectedAt,
            resumeAttempted: tracked.resumeAttempted,
            resumeSuccessful: tracked.resumeSuccessful,
        });
    }
    return resumable;
}
/**
 * Send resume sequence to a tmux pane
 *
 * This sends "1" followed by Enter to select the first option (usually "Continue"),
 * then waits briefly and sends "continue" if needed.
 *
 * @param paneId - The tmux pane ID
 * @returns Whether the command was sent successfully
 */
export function sendResumeSequence(paneId) {
    if (!isTmuxAvailable()) {
        return false;
    }
    // Herdr panes (wN:pM) are resumed through sendHerdrResumeSequence.
    if (isHerdrPaneId(paneId)) {
        return false;
    }
    // Validate pane ID to prevent command injection
    if (!isValidPaneId(paneId)) {
        console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
        return false;
    }
    try {
        // Send "1" to select the first option (typically "Continue" or similar)
        tmuxExec(['send-keys', '-t', paneId, '1', 'Enter'], {
            stripTmux: true,
            timeout: 2000,
        });
        // Wait a moment for the response
        // Note: In real usage, we should verify the pane state changed
        return true;
    }
    catch (error) {
        console.error(`[TmuxDetector] Error sending resume to pane ${paneId}:`, error);
        return false;
    }
}
// A tmux call that ran and exited non-zero, or that never started, sent nothing. A timeout, a signal or an error of
// unknown shape can have come after the key was typed.
function tmuxCallSentNothing(error) {
    const failure = error;
    if (typeof failure?.status === 'number' && failure.status !== 0 && !failure.signal)
        return true;
    return failure?.code === 'ENOENT' || failure?.code === 'EACCES';
}
/**
 * Send custom text to a tmux pane and report all three outcomes (see PaneSendOutcome). The text and the Enter
 * are two tmux calls, so a failure of the second leaves the text typed in the pane: that is `unconfirmed`, never
 * `not_attempted`.
 */
export function sendToPaneOutcome(paneId, text, pressEnter = true, socket, server) {
    if (!isTmuxAvailable()) {
        return 'not_attempted';
    }
    // Herdr panes (wN:pM) are addressed through the herdr agent surface.
    if (isHerdrPaneId(paneId)) {
        return 'not_attempted';
    }
    // Validate pane ID to prevent command injection
    if (!isValidPaneId(paneId)) {
        console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
        return 'not_attempted';
    }
    let sanitizedText;
    try {
        sanitizedText = sanitizeForTmux(text);
    }
    catch (error) {
        console.error(`[TmuxDetector] Error sending to pane ${paneId}:`, error);
        return 'not_attempted';
    }
    try {
        // Send text with -l flag (literal) to avoid key interpretation issues in TUI apps
        const call = tmuxCall(socket, server, ['send-keys', '-t', paneId, '-l', sanitizedText]);
        if (call === null)
            return 'not_attempted';
        const printed = tmuxExec(call.args, {
            stripTmux: true,
            timeout: 2000,
        });
        // The guard did not hold: another server run owns this pane id, and nothing was typed.
        if (call.marker !== null && printed.includes(call.marker))
            return 'not_attempted';
    }
    catch (error) {
        console.error(`[TmuxDetector] Error sending to pane ${paneId}:`, error);
        return tmuxCallSentNothing(error) ? 'not_attempted' : 'unconfirmed';
    }
    // Send Enter as a separate command so it is interpreted as a key press
    if (pressEnter) {
        try {
            const call = tmuxCall(socket, server, ['send-keys', '-t', paneId, 'Enter']);
            if (call === null)
                return 'unconfirmed';
            const printed = tmuxExec(call.args, {
                stripTmux: true,
                timeout: 2000,
            });
            // The text was typed in the pane of the earlier server run; whether it was submitted is not known.
            if (call.marker !== null && printed.includes(call.marker))
                return 'unconfirmed';
        }
        catch (error) {
            console.error(`[TmuxDetector] Error sending to pane ${paneId}:`, error);
            return 'unconfirmed';
        }
    }
    return 'delivered';
}
/**
 * Send custom text to a tmux pane
 */
export function sendToPane(paneId, text, pressEnter = true) {
    return sendToPaneOutcome(paneId, text, pressEnter) === 'delivered';
}
// ---------------------------------------------------------------------------
// Herdr arm
// ---------------------------------------------------------------------------
/**
 * Whether the herdr panes should be scanned. Conservative gate: only when the
 * multiplexer setting elects herdr (env OMC_TEAM_MULTIPLEXER or
 * team.ops.multiplexer). Ambient scanning is not enabled for herdr because a
 * scan implies the headless Herdr server (spawned on demand); default tmux
 * behavior is unchanged.
 */
export function isHerdrDetectorEnabled(env = process.env) {
    return resolveTeamMultiplexer(undefined, env) === 'herdr';
}
/** BlockedPane view of a live herdr agent pane. Pane ids are stable and never
 * reused, so the id (not window/pane indexes) is the identity that matters. */
function herdrBlockedPane(agent, analysis) {
    const paneId = agent.pane_id;
    let session = paneId;
    try {
        session = herdrWorkspaceIdFromPaneId(paneId);
    }
    catch {
        // keep the pane id as the session label if the grammar surprises us
    }
    return {
        id: paneId,
        session,
        windowIndex: 0,
        windowName: agent.name ?? agent.agent ?? '',
        paneIndex: 0,
        isActive: true,
        analysis,
        firstDetectedAt: new Date(),
        resumeAttempted: false,
    };
}
/**
 * Scan live herdr agent panes for blocked Claude Code sessions. Only panes
 * hosting a recognized agent are considered (the live-agent inventory is the
 * liveness proof; plain shell tabs are not agents). Returns [] when the
 * inventory cannot be read.
 */
export async function scanForBlockedHerdrPanes(lines = 15) {
    let agents;
    try {
        agents = await listHerdrAgents();
    }
    catch {
        return [];
    }
    const blocked = [];
    for (const agent of agents) {
        const paneId = agent.pane_id;
        let content;
        try {
            content = await captureHerdrWorkerPane(paneId, Math.max(1, Math.min(100, Math.floor(lines))));
        }
        catch {
            continue;
        }
        const analysis = analyzePaneContent(content);
        if (analysis.isBlocked) {
            blocked.push(herdrBlockedPane(agent, analysis));
        }
    }
    return blocked;
}
/**
 * Revalidate persisted herdr pane candidates before sending resume keys.
 * Mirrors revalidateBlockedPanes: null means "inconclusive" (the inventory
 * could not be read — callers retain state and retry), otherwise only panes
 * whose live agent still shows a rate-limit screen with a live resume menu
 * are returned.
 */
export async function revalidateBlockedHerdrPanes(trackedPanes, lines = 15) {
    if (trackedPanes.length === 0)
        return [];
    let agents;
    try {
        agents = await listHerdrAgents();
    }
    catch {
        return null;
    }
    const liveIds = new Set(agents.map((agent) => agent.pane_id));
    const resumable = [];
    for (const tracked of trackedPanes) {
        if (!isHerdrPaneId(tracked.id))
            continue;
        if (!liveIds.has(tracked.id))
            continue;
        let content;
        try {
            content = await captureHerdrWorkerPane(tracked.id, lines);
        }
        catch {
            return null;
        }
        const analysis = analyzePaneContent(content);
        const recentLines = content
            .split(/\r?\n/)
            .filter((line) => line.trim() &&
            !OMC_HUD_STATUS_LINE_PATTERN.test(line) &&
            !OMC_HUD_MODE_LINE_PATTERN.test(line))
            .join('\n');
        const recentLineList = recentLines.split('\n');
        const hasLivePrompt = hasLiveResumeMenuPrompt(recentLineList) ||
            hasLiveWaitAndContinuePrompt(recentLineList);
        if (!analysis.isBlocked ||
            !LIVE_RESUME_OPTION_PATTERN.test(recentLines) ||
            !hasLivePrompt)
            continue;
        resumable.push({
            ...tracked,
            analysis,
        });
    }
    return resumable;
}
/**
 * Send the resume confirmation to a herdr agent pane.
 *
 * tmux sends "1" + Enter to pick the first menu option. The herdr agent
 * surface types only semantic keys, so this confirms with Enter alone: the
 * live-menu revalidation above requires option 1 ("continue"/"wait") to be
 * the first resume option, and Claude's limit screen preselects it, making
 * Enter the equivalent of "1" + Enter.
 */
export async function sendHerdrResumeSequence(paneId) {
    if (!isHerdrPaneId(paneId)) {
        console.error(`[TmuxDetector] Not a herdr pane ID: ${paneId}`);
        return false;
    }
    try {
        await herdrSendKey(paneId, 'enter');
        return true;
    }
    catch (error) {
        console.error(`[TmuxDetector] Error sending herdr resume to pane ${paneId}:`, error);
        return false;
    }
}
/**
 * Get a summary of blocked panes for display
 */
export function formatBlockedPanesSummary(blockedPanes) {
    if (blockedPanes.length === 0) {
        return 'No blocked Claude Code sessions detected.';
    }
    const lines = [
        `Found ${blockedPanes.length} blocked Claude Code session(s):`,
        '',
    ];
    for (const pane of blockedPanes) {
        const location = `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`;
        const confidence = Math.round(pane.analysis.confidence * 100);
        const limitType = pane.analysis.rateLimitType || 'unknown';
        const status = pane.resumeAttempted
            ? pane.resumeSuccessful
                ? ' [RESUMED]'
                : ' [RESUME FAILED]'
            : '';
        lines.push(`  • ${location} (${pane.id}) - ${limitType} limit, ${confidence}% confidence${status}`);
    }
    return lines.join('\n');
}
/**
 * tmux adapter for the opt-in worker panel quota wait (OMC_PANEL_QUOTA_WAIT=1).
 * Strict capture: a pane that cannot be read is skipped, not treated as an empty screen.
 */
export const panelQuotaTmux = {
    // null when the inventory cannot be read (tmux missing, server unreachable, timeout): the pass keeps its saved waits.
    listPanes: () => listPanelQuotaPanes(),
    capture: (pane, lines) => capturePaneContentStrict(pane.id, lines, pane.socket, pane.server),
    sendContinue: (pane) => sendToPaneOutcome(pane.id, 'continue', true, pane.socket, pane.server),
    providerRunning: (pane) => paneProviderRunning(pane.id, pane.socket, pane.server),
    providerIdentity: (pane) => paneProviderIdentity(pane.id, pane.socket, pane.server),
};
/**
 * Whether the provider still runs in a pane. After the provider exits the pane keeps running the user's
 * shell, which shows the old error in its scrollback and would take a typed key as a command. False for a
 * dead pane or for the shell at its own prompt, true when something else runs in the foreground, null when
 * that cannot be told.
 *
 * A provider started through a shell wrapper script shows the shell as `pane_current_command`, so a shell
 * name alone does not mean the provider is gone: the terminal's foreground process group tells. At the
 * prompt it is the shell's own group; while a wrapper script or the provider runs it is another group.
 */
function paneProviderRunning(paneId, socket, server) {
    if (!isTmuxAvailable() || !isValidPaneId(paneId)) {
        return null;
    }
    try {
        const call = tmuxCall(socket, server, ['display-message', '-t', paneId, '-p', '#{pane_dead} #{pane_pid} #{pane_current_command}']);
        if (call === null)
            return null;
        const status = tmuxExec(call.args, { stripTmux: true, stdio: 'pipe', timeout: 3000 }).trim();
        // Another server run owns this pane id: nothing can be told about the pane that was listed.
        if (call.marker !== null && status.includes(call.marker))
            return null;
        const [dead, panePid, ...commandParts] = status.split(/\s+/);
        if (dead === '1') {
            return false;
        }
        // A login shell may be reported as "-bash".
        const command = commandParts.join(' ').replace(/^-+/, '');
        if (command === '') {
            return null;
        }
        if (!paneCurrentCommandLooksReady(command)) {
            return true;
        }
        return shellHasForegroundJob(panePid);
    }
    catch {
        return null;
    }
}
/**
 * What identifies the program that holds the pane's terminal: its process group (the foreground group of the pane's
 * terminal) and the start time of that group's leader. Two reads give the same value only while the same program runs
 * in the foreground; null when it cannot be told (dead pane, no terminal, ps unavailable).
 */
function paneProviderIdentity(paneId, socket, server) {
    if (!isTmuxAvailable() || !isValidPaneId(paneId)) {
        return null;
    }
    try {
        const call = tmuxCall(socket, server, ['display-message', '-t', paneId, '-p', '#{pane_dead} #{pane_pid}']);
        if (call === null)
            return null;
        const status = tmuxExec(call.args, { stripTmux: true, stdio: 'pipe', timeout: 3000 }).trim();
        if (call.marker !== null && status.includes(call.marker))
            return null;
        const [dead, panePid] = status.split(/\s+/);
        if (dead === '1' || !/^\d+$/.test(panePid ?? ''))
            return null;
        const foreground = execFileSync('ps', ['-o', 'tpgid=', '-p', panePid], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
        }).trim();
        if (!/^\d+$/.test(foreground) || Number(foreground) <= 0)
            return null;
        let started = '';
        try {
            // The start time is wall-clock text in the timezone and locale of the caller, and a wait outlives the process that
            // recorded it (a daemon restarted detached drops TZ): the same live process must read the same text, so the lookup
            // runs under a fixed timezone and locale.
            started = execFileSync('ps', ['-o', 'lstart=', '-p', foreground], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 3000,
                env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
            }).trim();
        }
        catch (error) {
            // The group leader may have exited while its group lives on (ps finds no such process and exits with status 1): the
            // group id alone identifies it. Any other failure (a timeout, a missing ps, a signal) says nothing about the
            // leader, so the identity cannot be told now and the caller tries again; an empty start time there would look
            // like a replaced program.
            if (error?.status !== 1)
                return null;
        }
        return `${foreground}:${started}`;
    }
    catch {
        return null;
    }
}
/** True when a job other than the shell itself holds the terminal of the pane's shell; null when ps cannot tell. */
function shellHasForegroundJob(shellPid) {
    if (!/^\d+$/.test(shellPid)) {
        return null;
    }
    try {
        const [pgid, tpgid] = execFileSync('ps', ['-o', 'pgid=,tpgid=', '-p', shellPid], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
        })
            .trim()
            .split(/\s+/);
        if (!/^\d+$/.test(pgid ?? '') || !/^-?\d+$/.test(tpgid ?? '')) {
            return null;
        }
        // tpgid is -1 when the process has no controlling terminal.
        return Number(tpgid) < 0 ? null : tpgid !== pgid;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=tmux-detector.js.map