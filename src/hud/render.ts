/**
 * OMC HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */

import type { HudRenderContext, HudConfig, LayoutConfig } from "./types.js";
import { DEFAULT_HUD_CONFIG, DEFAULT_ELEMENT_ORDER } from "./types.js";
import { bold, dim } from "./colors.js";
import { stringWidth, getCharWidth } from "../utils/string-width.js";
import { renderRalph } from "./elements/ralph.js";
import {
  renderAgentsByFormat,
  renderAgentsMultiLine,
} from "./elements/agents.js";
import { renderTodosWithCurrent } from "./elements/todos.js";
import { renderSkills, renderLastSkill } from "./elements/skills.js";
import { renderContext, renderContextWithBar } from "./elements/context.js";
import { renderBackground } from "./elements/background.js";
import { renderPrd } from "./elements/prd.js";
import {
  renderRateLimits,
  renderRateLimitsWithBar,
  renderRateLimitsError,
  renderCustomBuckets,
} from "./elements/limits.js";
import { renderPermission } from "./elements/permission.js";
import { renderThinking } from "./elements/thinking.js";
import { renderSession } from "./elements/session.js";
import { renderTokenUsage } from "./elements/token-usage.js";
import { renderPromptTime } from "./elements/prompt-time.js";
import { renderAutopilot } from "./elements/autopilot.js";
import { renderCwd } from "./elements/cwd.js";
import { renderHostname } from "./elements/hostname.js";
import { renderGitRepo, renderGitBranch } from "./elements/git.js";
import { renderModel } from "./elements/model.js";
import { renderApiKeySource } from "./elements/api-key-source.js";
import { renderCallCounts } from "./elements/call-counts.js";
import { renderContextLimitWarning } from "./elements/context-warning.js";
import { renderMissionBoard } from "./mission-board.js";
import { renderSessionSummary } from "./elements/session-summary.js";
import { renderLastTool } from "./elements/last-tool.js";

/**
 * ANSI escape sequence regex (matches SGR and other CSI sequences).
 * Used to skip escape codes when measuring/truncating visible width.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/;

const PLAIN_SEPARATOR = " | ";
const DIM_SEPARATOR = dim(PLAIN_SEPARATOR);

/**
 * Truncate a single line to a maximum visual width, preserving ANSI escape codes.
 * When the visible content exceeds maxWidth columns, it is truncated with an ellipsis.
 *
 * @param line - The line to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visual width in terminal columns
 * @returns Truncated line that fits within maxWidth visible columns
 */
export function truncateLineToMaxWidth(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(line) <= maxWidth) return line;

  const ELLIPSIS = "...";
  const ellipsisWidth = 3;
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);

  let visibleWidth = 0;
  let result = "";
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
    const codePoint = line.codePointAt(i)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const char = line.slice(i, i + codeUnits);
    const charWidth = getCharWidth(char);

    if (visibleWidth + charWidth > targetWidth) break;

    result += char;
    visibleWidth += charWidth;
    i += codeUnits;
  }

  // Append ANSI reset before ellipsis if any escape codes were seen,
  // to prevent color/style bleed into subsequent terminal output
  const reset = hasAnsi ? "\x1b[0m" : "";
  return result + reset + ELLIPSIS;
}

/**
 * Wrap a single line at HUD separator boundaries so each wrapped line
 * fits within maxWidth visible columns.
 *
 * Falls back to truncation when:
 * - no separator is present
 * - any single segment exceeds maxWidth
 */
function wrapLineToMaxWidth(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  if (stringWidth(line) <= maxWidth) return [line];

  const separator = line.includes(DIM_SEPARATOR)
    ? DIM_SEPARATOR
    : line.includes(PLAIN_SEPARATOR)
      ? PLAIN_SEPARATOR
      : null;

  if (!separator) {
    return [truncateLineToMaxWidth(line, maxWidth)];
  }

  const segments = line.split(separator);
  if (segments.length <= 1) {
    return [truncateLineToMaxWidth(line, maxWidth)];
  }

  const wrapped: string[] = [];
  let current = segments[0] ?? "";

  for (let i = 1; i < segments.length; i += 1) {
    const nextSegment = segments[i] ?? "";
    const candidate = `${current}${separator}${nextSegment}`;

    if (stringWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (stringWidth(current) > maxWidth) {
      wrapped.push(truncateLineToMaxWidth(current, maxWidth));
    } else {
      wrapped.push(current);
    }

    current = nextSegment;
  }

  if (stringWidth(current) > maxWidth) {
    wrapped.push(truncateLineToMaxWidth(current, maxWidth));
  } else {
    wrapped.push(current);
  }

  return wrapped;
}

/**
 * Apply maxWidth behavior by mode.
 */
function applyMaxWidthByMode(
  lines: string[],
  maxWidth: number | undefined,
  wrapMode: "truncate" | "wrap" | undefined,
): string[] {
  if (!maxWidth || maxWidth <= 0) return lines;

  if (wrapMode === "wrap") {
    return lines.flatMap((line) => wrapLineToMaxWidth(line, maxWidth));
  }

  return lines.map((line) => truncateLineToMaxWidth(line, maxWidth));
}

/**
 * Limit output lines to prevent input field shrinkage (Issue #222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export function limitOutputLines(lines: string[], maxLines?: number): string[] {
  const limit = Math.max(
    1,
    maxLines ?? DEFAULT_HUD_CONFIG.elements.maxOutputLines,
  );
  if (lines.length <= limit) {
    return lines;
  }
  const truncatedCount = lines.length - limit + 1;
  return [...lines.slice(0, limit - 1), `... (+${truncatedCount} lines)`];
}

/**
 * Render the complete statusline (single or multi-line)
 */
export async function render(
  context: HudRenderContext,
  config: HudConfig,
): Promise<string> {
  const { elements: enabledElements } = config;

  // ── Render all elements into maps ──────────────────────────────────
  // Each element is rendered independently and stored by name.
  // The layout (or DEFAULT_ELEMENT_ORDER) determines final ordering.
  const rendered = new Map<string, string>();
  const renderedDetail = new Map<string, string[]>();

  // -- line1-group elements (default: git info line) --

  if (enabledElements.hostname) {
    const hostnameElement = renderHostname();
    if (hostnameElement) rendered.set("hostname", hostnameElement);
  }

  if (enabledElements.cwd) {
    const cwdElement = renderCwd(
      context.cwd,
      enabledElements.cwdFormat || "relative",
      enabledElements.useHyperlinks ?? false,
    );
    if (cwdElement) rendered.set("cwd", cwdElement);
  }

  if (enabledElements.gitRepo) {
    const gitRepoElement = renderGitRepo(context.cwd);
    if (gitRepoElement) rendered.set("gitRepo", gitRepoElement);
  }

  if (enabledElements.gitBranch) {
    const gitBranchElement = renderGitBranch(context.cwd);
    if (gitBranchElement) rendered.set("gitBranch", gitBranchElement);
  }

  if (enabledElements.model && context.modelName) {
    const modelElement = renderModel(
      context.modelName,
      enabledElements.modelFormat,
    );
    if (modelElement) rendered.set("model", modelElement);
  }

  if (enabledElements.apiKeySource && context.apiKeySource) {
    const keySource = renderApiKeySource(context.apiKeySource);
    if (keySource) rendered.set("apiKeySource", keySource);
  }

  if (enabledElements.profile && context.profileName) {
    rendered.set("profile", bold(`profile:${context.profileName}`));
  }

  // -- main-group elements (default: main statusline) --

  if (enabledElements.omcLabel) {
    const versionTag = context.omcVersion ? `#${context.omcVersion}` : "";
    if (context.updateAvailable) {
      rendered.set(
        "omcLabel",
        bold(`[OMC${versionTag}] -> ${context.updateAvailable} omc update`),
      );
    } else {
      rendered.set("omcLabel", bold(`[OMC${versionTag}]`));
    }
  }

  // Rate limits (5h and weekly) - data takes priority over error indicator
  if (enabledElements.rateLimits && context.rateLimitsResult) {
    if (context.rateLimitsResult.rateLimits) {
      const stale = context.rateLimitsResult.stale;
      const limits = enabledElements.useBars
        ? renderRateLimitsWithBar(
            context.rateLimitsResult.rateLimits,
            undefined,
            stale,
          )
        : renderRateLimits(context.rateLimitsResult.rateLimits, stale);
      if (limits) rendered.set("rateLimits", limits);
    } else {
      const errorIndicator = renderRateLimitsError(context.rateLimitsResult);
      if (errorIndicator) rendered.set("rateLimits", errorIndicator);
    }
  }

  if (context.customBuckets) {
    const thresholdPercent =
      config.rateLimitsProvider?.resetsAtDisplayThresholdPercent;
    const custom = renderCustomBuckets(context.customBuckets, thresholdPercent);
    if (custom) rendered.set("customBuckets", custom);
  }

  if (enabledElements.permissionStatus && context.pendingPermission) {
    const permission = renderPermission(context.pendingPermission);
    if (permission) rendered.set("permission", permission);
  }

  if (enabledElements.thinking && context.thinkingState) {
    const thinking = renderThinking(
      context.thinkingState,
      enabledElements.thinkingFormat,
    );
    if (thinking) rendered.set("thinking", thinking);
  }

  if (enabledElements.promptTime) {
    const prompt = renderPromptTime(context.promptTime, new Date());
    if (prompt) rendered.set("promptTime", prompt);
  }

  if (enabledElements.sessionHealth && context.sessionHealth) {
    const showDuration = enabledElements.showSessionDuration ?? true;
    if (showDuration) {
      const session = renderSession(context.sessionHealth);
      if (session) rendered.set("session", session);
    }
  }

  if (enabledElements.showTokens === true) {
    const tokenUsage = renderTokenUsage(
      context.lastRequestTokenUsage,
      context.sessionTotalTokens,
    );
    if (tokenUsage) rendered.set("tokens", tokenUsage);
  }

  if (enabledElements.ralph && context.ralph) {
    const ralph = renderRalph(context.ralph, config.thresholds);
    if (ralph) rendered.set("ralph", ralph);
  }

  if (enabledElements.autopilot && context.autopilot) {
    const autopilot = renderAutopilot(context.autopilot, config.thresholds);
    if (autopilot) rendered.set("autopilot", autopilot);
  }

  if (enabledElements.prdStory && context.prd) {
    const prd = renderPrd(context.prd);
    if (prd) rendered.set("prd", prd);
  }

  if (enabledElements.activeSkills) {
    const skills = renderSkills(
      context.ultrawork,
      context.ralph,
      (enabledElements.lastSkill ?? true) ? context.lastSkill : null,
    );
    if (skills) rendered.set("skills", skills);
  }

  if ((enabledElements.lastSkill ?? true) && !enabledElements.activeSkills) {
    const lastSkillElement = renderLastSkill(context.lastSkill);
    if (lastSkillElement) rendered.set("lastSkill", lastSkillElement);
  }

  if (enabledElements.contextBar) {
    const ctx = enabledElements.useBars
      ? renderContextWithBar(
          context.contextPercent,
          config.thresholds,
          10,
          context.contextDisplayScope,
        )
      : renderContext(
          context.contextPercent,
          config.thresholds,
          context.contextDisplayScope,
        );
    if (ctx) rendered.set("contextBar", ctx);
  }

  // Active agents - handle multi-line format specially
  if (enabledElements.agents) {
    const format = enabledElements.agentsFormat || "codes";

    if (format === "multiline") {
      const maxLines = enabledElements.agentsMaxLines || 5;
      const result = renderAgentsMultiLine(context.activeAgents, maxLines);
      if (result.headerPart) rendered.set("agents", result.headerPart);
      if (result.detailLines.length > 0) {
        renderedDetail.set("agents", result.detailLines);
      }
    } else {
      const agents = renderAgentsByFormat(context.activeAgents, format);
      if (agents) rendered.set("agents", agents);
    }
  }

  if (enabledElements.backgroundTasks) {
    const bg = renderBackground(context.backgroundTasks);
    if (bg) rendered.set("background", bg);
  }

  const showCounts = enabledElements.showCallCounts ?? true;
  if (showCounts) {
    const counts = renderCallCounts(
      context.toolCallCount,
      context.agentCallCount,
      context.skillCallCount,
      enabledElements.callCountsFormat ?? 'auto',
    );
    if (counts) rendered.set("callCounts", counts);
  }

  if (enabledElements.showLastTool === true) {
    const tool = renderLastTool(context.lastToolName ?? null);
    if (tool) rendered.set("lastTool", tool);
  }

  if (enabledElements.sessionSummary && context.sessionSummary) {
    const summary = renderSessionSummary(context.sessionSummary);
    if (summary) rendered.set("sessionSummary", summary);
  }

  // -- detail-group elements --

  if (
    context.missionBoard &&
    (config.missionBoard?.enabled ?? config.elements.missionBoard ?? false)
  ) {
    const mbLines = renderMissionBoard(context.missionBoard, config.missionBoard);
    if (mbLines.length > 0) renderedDetail.set("missionBoard", mbLines);
  }

  const ctxWarning = renderContextLimitWarning(
    context.contextPercent,
    config.contextLimitWarning.threshold,
    config.contextLimitWarning.autoCompact,
  );
  if (ctxWarning) renderedDetail.set("contextWarning", [ctxWarning]);

  if (enabledElements.todos) {
    const todos = renderTodosWithCurrent(context.todos);
    if (todos) renderedDetail.set("todos", [todos]);
  }

  // ── Assemble output using layout order ─────────────────────────────
  const safeArray = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v : fallback;

  const effectiveLayout: Required<LayoutConfig> = {
    line1: safeArray(config.layout?.line1, DEFAULT_ELEMENT_ORDER.line1),
    main: safeArray(config.layout?.main, DEFAULT_ELEMENT_ORDER.main),
    detail: safeArray(config.layout?.detail, DEFAULT_ELEMENT_ORDER.detail),
  };

  /** Collect inline elements in layout order.
   *  Also picks up detail-origin elements moved to an inline group —
   *  their detail lines are joined into a single inline string. */
  function collectInline(order: string[]): string[] {
    const result: string[] = [];
    for (const name of order) {
      const el = rendered.get(name);
      if (el) {
        result.push(el);
      } else {
        // Detail elements moved to an inline group render as joined inline
        const lines = renderedDetail.get(name);
        if (lines && lines.length > 0) result.push(lines.join(" "));
      }
    }
    return result;
  }

  /** Collect detail lines in layout order.
   *  Also picks up inline elements moved to the detail group —
   *  they become individual detail lines when placed here. */
  function collectDetailLines(order: string[]): string[] {
    const result: string[] = [];
    for (const name of order) {
      const lines = renderedDetail.get(name);
      if (lines) result.push(...lines);
      // Inline elements moved to the detail group render as detail lines
      if (!lines) {
        const inline = rendered.get(name);
        if (inline) result.push(inline);
      }
    }
    return result;
  }

  const gitElements = collectInline(effectiveLayout.line1);
  const elements = collectInline(effectiveLayout.main);

  // Detail lines from the detail group layout order.
  // Elements like 'agents' appear in both main (inline) and detail (detail lines),
  // preserving legacy ordering: missionBoard, agents detail, contextWarning, todos.
  const detailLines = collectDetailLines(effectiveLayout.detail);

  // Compose output
  const outputLines: string[] = [];
  const gitInfoLine =
    gitElements.length > 0 ? gitElements.join(dim(PLAIN_SEPARATOR)) : null;
  const headerLine =
    elements.length > 0 ? elements.join(dim(PLAIN_SEPARATOR)) : null;

  const gitPosition = config.elements.gitInfoPosition ?? "above";

  if (gitPosition === "above") {
    if (gitInfoLine) {
      outputLines.push(gitInfoLine);
    }
    if (headerLine) {
      outputLines.push(headerLine);
    }
  } else {
    if (headerLine) {
      outputLines.push(headerLine);
    }
    if (gitInfoLine) {
      outputLines.push(gitInfoLine);
    }
  }

  const widthAdjustedLines = applyMaxWidthByMode(
    [...outputLines, ...detailLines],
    config.maxWidth,
    config.wrapMode,
  );

  // Apply max output line limit after wrapping so wrapped output still respects maxOutputLines.
  const limitedLines = limitOutputLines(
    widthAdjustedLines,
    config.elements.maxOutputLines,
  );

  // Ensure line-limit indicator and all other lines still respect maxWidth.
  const finalLines =
    config.maxWidth && config.maxWidth > 0
      ? limitedLines.map((line) =>
          truncateLineToMaxWidth(line, config.maxWidth!),
        )
      : limitedLines;

  return finalLines.join("\n");
}
