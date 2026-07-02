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
import { tmuxExec, tmuxSpawn } from '../../cli/tmux-utils.js';
import { getNewPaneTail } from './pane-fresh-capture.js';
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
/** Patterns that indicate Claude Code is running */
const CLAUDE_CODE_PATTERNS = [
    /claude/i,
    /anthropic/i,
    /\$ claude/,
    /claude code/i,
    /conversation/i,
    /assistant/i,
];
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
/**
 * List all tmux panes across all sessions
 */
export function listTmuxPanes() {
    if (!isTmuxAvailable()) {
        return [];
    }
    try {
        // Format: session_name:window_index.pane_index pane_id pane_active window_name pane_title
        const format = '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pane_active} #{window_name} #{pane_title}';
        const result = tmuxExec(['list-panes', '-a', '-F', format], {
            stripTmux: true,
            timeout: 5000,
        });
        const panes = [];
        for (const line of result.trim().split('\n')) {
            if (!line.trim())
                continue;
            const parts = line.split(' ');
            if (parts.length < 4)
                continue;
            const [location, paneId, activeStr, windowName, ...titleParts] = parts;
            const [sessionWindow, paneIndexStr] = location.split('.');
            const [session, windowIndexStr] = sessionWindow.split(':');
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
    catch (error) {
        console.error('[TmuxDetector] Error listing panes:', error);
        return [];
    }
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
export function capturePaneContent(paneId, lines = 15) {
    if (!isTmuxAvailable()) {
        return '';
    }
    // Validate pane ID to prevent command injection
    if (!isValidPaneId(paneId)) {
        console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
        return '';
    }
    // Validate lines is a reasonable positive integer
    const safeLines = Math.max(1, Math.min(100, Math.floor(lines)));
    try {
        // Capture the last N lines from the pane
        const result = tmuxExec(['capture-pane', '-t', paneId, '-p', '-S', `-${safeLines}`], {
            stripTmux: true,
            timeout: 5000,
        });
        return result;
    }
    catch (error) {
        console.error(`[TmuxDetector] Error capturing pane ${paneId}:`, error);
        return '';
    }
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
    // Check for Claude Code indicators
    const hasClaudeCode = CLAUDE_CODE_PATTERNS.some((pattern) => pattern.test(cleanedContent));
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
/**
 * Send custom text to a tmux pane
 */
export function sendToPane(paneId, text, pressEnter = true) {
    if (!isTmuxAvailable()) {
        return false;
    }
    // Validate pane ID to prevent command injection
    if (!isValidPaneId(paneId)) {
        console.error(`[TmuxDetector] Invalid pane ID format: ${paneId}`);
        return false;
    }
    try {
        const sanitizedText = sanitizeForTmux(text);
        // Send text with -l flag (literal) to avoid key interpretation issues in TUI apps
        tmuxExec(['send-keys', '-t', paneId, '-l', sanitizedText], {
            stripTmux: true,
            timeout: 2000,
        });
        // Send Enter as a separate command so it is interpreted as a key press
        if (pressEnter) {
            tmuxExec(['send-keys', '-t', paneId, 'Enter'], {
                stripTmux: true,
                timeout: 2000,
            });
        }
        return true;
    }
    catch (error) {
        console.error(`[TmuxDetector] Error sending to pane ${paneId}:`, error);
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
//# sourceMappingURL=tmux-detector.js.map