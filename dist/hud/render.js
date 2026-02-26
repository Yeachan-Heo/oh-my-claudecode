/**
 * OMC HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */
import { DEFAULT_HUD_CONFIG } from './types.js';
import { bold, dim } from './colors.js';
import { stringWidth, getCharWidth } from '../utils/string-width.js';
import { renderRalph } from './elements/ralph.js';
import { renderAgentsByFormat, renderAgentsMultiLine } from './elements/agents.js';
import { renderTodosWithCurrent } from './elements/todos.js';
import { renderSkills, renderLastSkill } from './elements/skills.js';
import { renderContext, renderContextWithBar } from './elements/context.js';
import { renderBackground } from './elements/background.js';
import { renderPrd } from './elements/prd.js';
import { renderRateLimits, renderRateLimitsWithBar, renderCustomBuckets } from './elements/limits.js';
import { renderPermission } from './elements/permission.js';
import { renderThinking } from './elements/thinking.js';
import { renderSession } from './elements/session.js';
import { renderPromptTime } from './elements/prompt-time.js';
import { renderAutopilot } from './elements/autopilot.js';
import { renderCwd } from './elements/cwd.js';
import { renderGitRepo, renderGitBranch } from './elements/git.js';
import { renderModel } from './elements/model.js';
import { renderCallCounts } from './elements/call-counts.js';
import { renderContextLimitWarning } from './elements/context-warning.js';
/**
 * ANSI escape sequence regex (matches SGR and other CSI sequences).
 * Used to skip escape codes when measuring/truncating visible width.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/;
/**
 * Truncate a single line to a maximum visual width, preserving ANSI escape codes.
 * When the visible content exceeds maxWidth columns, it is truncated with an ellipsis.
 *
 * @param line - The line to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visual width in terminal columns
 * @returns Truncated line that fits within maxWidth visible columns
 */
export function truncateLineToMaxWidth(line, maxWidth) {
    if (maxWidth <= 0)
        return '';
    if (stringWidth(line) <= maxWidth)
        return line;
    const ELLIPSIS = '...';
    const ellipsisWidth = 3;
    const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
    let visibleWidth = 0;
    let result = '';
    let hasAnsi = false;
    let i = 0;
    while (i < line.length) {
        // Check for ANSI escape sequence at current position
        const remaining = line.slice(i);
        const ansiMatch = remaining.match(ANSI_REGEX);
        if (ansiMatch && ansiMatch.index === 0) {
            // Pass through the entire ANSI sequence without counting width
            result += ansiMatch[0];
            hasAnsi = true;
            i += ansiMatch[0].length;
            continue;
        }
        // Read the full code point (handles surrogate pairs for astral-plane chars like emoji)
        const codePoint = line.codePointAt(i);
        const codeUnits = codePoint > 0xFFFF ? 2 : 1;
        const char = line.slice(i, i + codeUnits);
        const charWidth = getCharWidth(char);
        if (visibleWidth + charWidth > targetWidth)
            break;
        result += char;
        visibleWidth += charWidth;
        i += codeUnits;
    }
    // Append ANSI reset before ellipsis if any escape codes were seen,
    // to prevent color/style bleed into subsequent terminal output
    const reset = hasAnsi ? '\x1b[0m' : '';
    return result + reset + ELLIPSIS;
}
/**
 * Limit output lines to prevent input field shrinkage (Issue #222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export function limitOutputLines(lines, maxLines) {
    const limit = Math.max(1, maxLines ?? DEFAULT_HUD_CONFIG.elements.maxOutputLines);
    if (lines.length <= limit) {
        return lines;
    }
    const truncatedCount = lines.length - limit + 1;
    return [...lines.slice(0, limit - 1), `... (+${truncatedCount} lines)`];
}
/**
 * Render the complete statusline (single or multi-line)
 */
export async function render(context, config) {
    const elements = [];
    const detailLines = [];
    const { elements: enabledElements } = config;
    // Git info line (separate line above HUD)
    const gitElements = [];
    // Working directory
    if (enabledElements.cwd) {
        const cwdElement = renderCwd(context.cwd, enabledElements.cwdFormat || 'relative');
        if (cwdElement)
            gitElements.push(cwdElement);
    }
    // Git repository name
    if (enabledElements.gitRepo) {
        const gitRepoElement = renderGitRepo(context.cwd);
        if (gitRepoElement)
            gitElements.push(gitRepoElement);
    }
    // Git branch
    if (enabledElements.gitBranch) {
        const gitBranchElement = renderGitBranch(context.cwd);
        if (gitBranchElement)
            gitElements.push(gitBranchElement);
    }
    // Model name
    if (enabledElements.model && context.modelName) {
        const modelElement = renderModel(context.modelName, enabledElements.modelFormat);
        if (modelElement)
            gitElements.push(modelElement);
    }
    // [OMC#X.Y.Z] label with optional update notification
    if (enabledElements.omcLabel) {
        const versionTag = context.omcVersion ? `#${context.omcVersion}` : '';
        if (context.updateAvailable) {
            elements.push(bold(`[OMC${versionTag}] -> ${context.updateAvailable} omc update`));
        }
        else {
            elements.push(bold(`[OMC${versionTag}]`));
        }
    }
    // Rate limits (5h and weekly)
    if (enabledElements.rateLimits && context.rateLimits) {
        const limits = enabledElements.useBars
            ? renderRateLimitsWithBar(context.rateLimits)
            : renderRateLimits(context.rateLimits);
        if (limits)
            elements.push(limits);
    }
    // Custom rate limit buckets
    if (context.customBuckets) {
        const thresholdPercent = config.rateLimitsProvider?.resetsAtDisplayThresholdPercent;
        const custom = renderCustomBuckets(context.customBuckets, thresholdPercent);
        if (custom)
            elements.push(custom);
    }
    // Permission status indicator (heuristic-based)
    if (enabledElements.permissionStatus && context.pendingPermission) {
        const permission = renderPermission(context.pendingPermission);
        if (permission)
            elements.push(permission);
    }
    // Extended thinking indicator
    if (enabledElements.thinking && context.thinkingState) {
        const thinking = renderThinking(context.thinkingState, enabledElements.thinkingFormat || 'text');
        if (thinking)
            elements.push(thinking);
    }
    // Prompt submission time
    if (enabledElements.promptTime) {
        const prompt = renderPromptTime(context.promptTime);
        if (prompt)
            elements.push(prompt);
    }
    // Session health indicator
    if (enabledElements.sessionHealth && context.sessionHealth) {
        // Session duration display (session:19m)
        // If showSessionDuration is explicitly set, use it; otherwise default to true (backward compat)
        const showDuration = enabledElements.showSessionDuration ?? true;
        if (showDuration) {
            const session = renderSession(context.sessionHealth);
            if (session)
                elements.push(session);
        }
    }
    // Ralph loop state
    if (enabledElements.ralph && context.ralph) {
        const ralph = renderRalph(context.ralph, config.thresholds);
        if (ralph)
            elements.push(ralph);
    }
    // Autopilot state (takes precedence over ralph in display)
    if (enabledElements.autopilot && context.autopilot) {
        const autopilot = renderAutopilot(context.autopilot, config.thresholds);
        if (autopilot)
            elements.push(autopilot);
    }
    // PRD story
    if (enabledElements.prdStory && context.prd) {
        const prd = renderPrd(context.prd);
        if (prd)
            elements.push(prd);
    }
    // Active skills (ultrawork, etc.) + last skill
    if (enabledElements.activeSkills) {
        const skills = renderSkills(context.ultrawork, context.ralph, (enabledElements.lastSkill ?? true) ? context.lastSkill : null);
        if (skills)
            elements.push(skills);
    }
    // Standalone last skill element (if activeSkills disabled but lastSkill enabled)
    if ((enabledElements.lastSkill ?? true) && !enabledElements.activeSkills) {
        const lastSkillElement = renderLastSkill(context.lastSkill);
        if (lastSkillElement)
            elements.push(lastSkillElement);
    }
    // Context window
    if (enabledElements.contextBar) {
        const ctx = enabledElements.useBars
            ? renderContextWithBar(context.contextPercent, config.thresholds)
            : renderContext(context.contextPercent, config.thresholds);
        if (ctx)
            elements.push(ctx);
    }
    // Active agents - handle multi-line format specially
    if (enabledElements.agents) {
        const format = enabledElements.agentsFormat || 'codes';
        if (format === 'multiline') {
            // Multi-line mode: get header part and detail lines
            const maxLines = enabledElements.agentsMaxLines || 5;
            const result = renderAgentsMultiLine(context.activeAgents, maxLines);
            if (result.headerPart)
                elements.push(result.headerPart);
            detailLines.push(...result.detailLines);
        }
        else {
            // Single-line mode: standard format
            const agents = renderAgentsByFormat(context.activeAgents, format);
            if (agents)
                elements.push(agents);
        }
    }
    // Background tasks
    if (enabledElements.backgroundTasks) {
        const bg = renderBackground(context.backgroundTasks);
        if (bg)
            elements.push(bg);
    }
    // Call counts on the right side of the status line (Issue #710)
    // Controlled by showCallCounts config option (default: true)
    const showCounts = enabledElements.showCallCounts ?? true;
    if (showCounts) {
        const counts = renderCallCounts(context.toolCallCount, context.agentCallCount, context.skillCallCount);
        if (counts)
            elements.push(counts);
    }
    // Context limit warning banner (shown when ctx% >= threshold)
    const ctxWarning = renderContextLimitWarning(context.contextPercent, config.contextLimitWarning.threshold, config.contextLimitWarning.autoCompact);
    if (ctxWarning)
        detailLines.push(ctxWarning);
    // Compose output
    const outputLines = [];
    // Git info line (separate line above HUD header)
    if (gitElements.length > 0) {
        outputLines.push(gitElements.join(dim(' | ')));
    }
    // HUD header line
    const headerLine = elements.join(dim(' | '));
    outputLines.push(headerLine);
    // Todos on next line (if available)
    if (enabledElements.todos) {
        const todos = renderTodosWithCurrent(context.todos);
        if (todos)
            detailLines.push(todos);
    }
    let finalLines = limitOutputLines([...outputLines, ...detailLines], config.elements.maxOutputLines);
    // Apply maxWidth truncation if configured (Issue #1086)
    if (config.maxWidth && config.maxWidth > 0) {
        finalLines = finalLines.map(line => truncateLineToMaxWidth(line, config.maxWidth));
    }
    return finalLines.join('\n');
}
//# sourceMappingURL=render.js.map