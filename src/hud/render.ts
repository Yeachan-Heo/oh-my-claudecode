/**
 * OMC HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */

import type { HudRenderContext, HudConfig } from './types.js';
import { DEFAULT_HUD_CONFIG } from './types.js';
import { bold, dim } from './colors.js';
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
import { renderAutopilot } from './elements/autopilot.js';
import { renderCwd } from './elements/cwd.js';
import { renderGitRepo, renderGitBranch } from './elements/git.js';
import { renderModel } from './elements/model.js';
import { renderCallCounts } from './elements/call-counts.js';
import { renderContextLimitWarning } from './elements/context-warning.js';
import {
  getAnalyticsDisplay,
  renderAnalyticsLineWithConfig,
  getSessionInfo,
  getSessionHealthAnalyticsData,
  renderBudgetWarning,
  renderCacheEfficiency
} from './analytics-display.js';
import type { SessionHealth, HudElementConfig } from './types.js';

/**
 * Limit output lines to prevent input field shrinkage (Issue #222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export function limitOutputLines(lines: string[], maxLines?: number): string[] {
  const limit = Math.max(1, maxLines ?? DEFAULT_HUD_CONFIG.elements.maxOutputLines);
  if (lines.length <= limit) {
    return lines;
  }
  const truncatedCount = lines.length - limit + 1;
  return [...lines.slice(0, limit - 1), `... (+${truncatedCount} lines)`];
}

/**
 * Render session health analytics respecting config toggles.
 * Composes output from getSessionHealthAnalyticsData() based on showCache/showCost flags.
 */
function renderSessionHealthAnalyticsWithConfig(
  sessionHealth: SessionHealth,
  enabledElements: HudElementConfig
): string {
  const data = getSessionHealthAnalyticsData(sessionHealth);
  const parts: string[] = [];

  // Health indicator (🟢/🟡/🔴) - controlled by showHealthIndicator
  const showIndicator = enabledElements.showHealthIndicator ?? true;

  // Cost indicator and cost amount (respects showCost)
  if (enabledElements.showCost) {
    if (showIndicator) {
      parts.push(data.costIndicator, data.cost);
    } else {
      parts.push(data.cost);
    }
  } else if (showIndicator) {
    // Show indicator even without cost
    parts.push(data.costIndicator);
  }

  // Tokens - controlled by showTokens
  const showTokens = enabledElements.showTokens ?? true;
  if (showTokens) {
    parts.push(data.tokens);
  }

  // Cache (respects showCache)
  if (enabledElements.showCache) {
    parts.push(`Cache: ${data.cache}`);
  }

  // Cost per hour
  // If showCostPerHour is explicitly set, use it; otherwise default to true (backward compat)
  const showCostHour = enabledElements.showCostPerHour ?? true;
  if (showCostHour && enabledElements.showCost && data.costHour) {
    parts.push(data.costHour);
  }

  return parts.join(' | ');
}

/**
 * Render the complete statusline (single or multi-line)
 */
export async function render(context: HudRenderContext, config: HudConfig): Promise<string> {
  const elements: string[] = [];
  const detailLines: string[] = [];
  const { elements: enabledElements } = config;

  // Check if analytics preset is active
  if (config.preset === 'analytics') {
    const analytics = await getAnalyticsDisplay();
    const sessionInfo = await getSessionInfo();

    // Render analytics-focused layout
    const lines = [sessionInfo, renderAnalyticsLineWithConfig(analytics, enabledElements.showCost, enabledElements.showCache)];

    // Add SessionHealth analytics if available
    if (context.sessionHealth) {
      const healthAnalytics = renderSessionHealthAnalyticsWithConfig(context.sessionHealth, enabledElements);
      if (healthAnalytics) lines.push(healthAnalytics);

      // Cache efficiency (respects showCache)
      if (enabledElements.showCache) {
        const cacheEfficiency = renderCacheEfficiency(context.sessionHealth);
        if (cacheEfficiency) lines.push(cacheEfficiency);
      }

      // Budget warning
      // If showBudgetWarning is explicitly set, use it; otherwise default to true (backward compat)
      const showBudgetAnalytics = enabledElements.showBudgetWarning ?? true;
      if (showBudgetAnalytics && enabledElements.showCost) {
        const budgetWarning = renderBudgetWarning(context.sessionHealth, config.thresholds);
        if (budgetWarning) lines.push(budgetWarning);
      }
    }

    // Add agents if available
    if (context.activeAgents.length > 0) {
      const agents = renderAgentsByFormat(context.activeAgents, enabledElements.agentsFormat || 'codes');
      if (agents) lines.push(agents);
    }

    // Add todos if available
    if (enabledElements.todos) {
      const todos = renderTodosWithCurrent(context.todos);
      if (todos) lines.push(todos);
    }

    return limitOutputLines(lines, config.elements.maxOutputLines).join('\n');
  }

  // Git info line (separate line above HUD)
  const gitElements: string[] = [];

  // Working directory
  if (enabledElements.cwd) {
    const cwdElement = renderCwd(context.cwd, enabledElements.cwdFormat || 'relative');
    if (cwdElement) gitElements.push(cwdElement);
  }

  // Git repository name
  if (enabledElements.gitRepo) {
    const gitRepoElement = renderGitRepo(context.cwd);
    if (gitRepoElement) gitElements.push(gitRepoElement);
  }

  // Git branch
  if (enabledElements.gitBranch) {
    const gitBranchElement = renderGitBranch(context.cwd);
    if (gitBranchElement) gitElements.push(gitBranchElement);
  }

  // Model name
  if (enabledElements.model && context.modelName) {
    const modelElement = renderModel(context.modelName, enabledElements.modelFormat);
    if (modelElement) gitElements.push(modelElement);
  }

  // [OMC#X.Y.Z] label with optional update notification
  if (enabledElements.omcLabel) {
    const versionTag = context.omcVersion ? `#${context.omcVersion}` : '';
    if (context.updateAvailable) {
      elements.push(bold(`[OMC${versionTag}] -> ${context.updateAvailable} omc update`));
    } else {
      elements.push(bold(`[OMC${versionTag}]`));
    }
  }

  // Rate limits (5h and weekly)
  if (enabledElements.rateLimits && context.rateLimits) {
    const limits = enabledElements.useBars
      ? renderRateLimitsWithBar(context.rateLimits)
      : renderRateLimits(context.rateLimits);
    if (limits) elements.push(limits);
  }

  // Custom rate limit buckets
  if (context.customBuckets) {
    const thresholdPercent = config.rateLimitsProvider?.resetsAtDisplayThresholdPercent;
    const custom = renderCustomBuckets(context.customBuckets, thresholdPercent);
    if (custom) elements.push(custom);
  }

  // Permission status indicator (heuristic-based)
  if (enabledElements.permissionStatus && context.pendingPermission) {
    const permission = renderPermission(context.pendingPermission);
    if (permission) elements.push(permission);
  }

  // Extended thinking indicator
  if (enabledElements.thinking && context.thinkingState) {
    const thinking = renderThinking(context.thinkingState, enabledElements.thinkingFormat || 'text');
    if (thinking) elements.push(thinking);
  }

  // Session health indicator
  if (enabledElements.sessionHealth && context.sessionHealth) {
    // Session duration display (session:19m)
    // If showSessionDuration is explicitly set, use it; otherwise default to true (backward compat)
    const showDuration = enabledElements.showSessionDuration ?? true;
    if (showDuration) {
      const session = renderSession(context.sessionHealth);
      if (session) elements.push(session);
    }

    // Add analytics inline if available (respects showCache/showCost)
    const analytics = renderSessionHealthAnalyticsWithConfig(context.sessionHealth, enabledElements);
    if (analytics) elements.push(analytics);

    // Add budget warning to detail lines
    // If showBudgetWarning is explicitly set, use it; otherwise default to true (backward compat)
    const showBudget = enabledElements.showBudgetWarning ?? true;
    if (showBudget && enabledElements.showCost) {
      const warning = renderBudgetWarning(context.sessionHealth, config.thresholds);
      if (warning) detailLines.push(warning);
    }
  }

  // Ralph loop state
  if (enabledElements.ralph && context.ralph) {
    const ralph = renderRalph(context.ralph, config.thresholds);
    if (ralph) elements.push(ralph);
  }

  // Autopilot state (takes precedence over ralph in display)
  if (enabledElements.autopilot && context.autopilot) {
    const autopilot = renderAutopilot(context.autopilot, config.thresholds);
    if (autopilot) elements.push(autopilot);
  }

  // PRD story
  if (enabledElements.prdStory && context.prd) {
    const prd = renderPrd(context.prd);
    if (prd) elements.push(prd);
  }

  // Active skills (ultrawork, etc.) + last skill
  if (enabledElements.activeSkills) {
    const skills = renderSkills(
      context.ultrawork,
      context.ralph,
      (enabledElements.lastSkill ?? true) ? context.lastSkill : null
    );
    if (skills) elements.push(skills);
  }

  // Standalone last skill element (if activeSkills disabled but lastSkill enabled)
  if ((enabledElements.lastSkill ?? true) && !enabledElements.activeSkills) {
    const lastSkillElement = renderLastSkill(context.lastSkill);
    if (lastSkillElement) elements.push(lastSkillElement);
  }

  // Context window
  if (enabledElements.contextBar) {
    const ctx = enabledElements.useBars
      ? renderContextWithBar(context.contextPercent, config.thresholds)
      : renderContext(context.contextPercent, config.thresholds);
    if (ctx) elements.push(ctx);
  }

  // Active agents - handle multi-line format specially
  if (enabledElements.agents) {
    const format = enabledElements.agentsFormat || 'codes';

    if (format === 'multiline') {
      // Multi-line mode: get header part and detail lines
      const maxLines = enabledElements.agentsMaxLines || 5;
      const result = renderAgentsMultiLine(context.activeAgents, maxLines);
      if (result.headerPart) elements.push(result.headerPart);
      detailLines.push(...result.detailLines);
    } else {
      // Single-line mode: standard format
      const agents = renderAgentsByFormat(context.activeAgents, format);
      if (agents) elements.push(agents);
    }
  }

  // Background tasks
  if (enabledElements.backgroundTasks) {
    const bg = renderBackground(context.backgroundTasks);
    if (bg) elements.push(bg);
  }

  // Call counts on the right side of the status line (Issue #710)
  // Controlled by showCallCounts config option (default: true)
  const showCounts = enabledElements.showCallCounts ?? true;
  if (showCounts) {
    const counts = renderCallCounts(
      context.toolCallCount,
      context.agentCallCount,
      context.skillCallCount,
    );
    if (counts) elements.push(counts);
  }

  // Context limit warning banner (shown when ctx% >= threshold)
  const ctxWarning = renderContextLimitWarning(
    context.contextPercent,
    config.contextLimitWarning.threshold,
    config.contextLimitWarning.autoCompact
  );
  if (ctxWarning) detailLines.push(ctxWarning);

  // Compose output
  const outputLines: string[] = [];

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
    if (todos) detailLines.push(todos);
  }

  // Optionally add analytics line for full/dense presets
  if (config.preset === 'full' || config.preset === 'dense') {
    try {
      const analytics = await getAnalyticsDisplay();
      detailLines.push(renderAnalyticsLineWithConfig(analytics, enabledElements.showCost, enabledElements.showCache));

      // Also add cache efficiency if SessionHealth available (respects showCache)
      if (enabledElements.showCache && context.sessionHealth?.cacheHitRate !== undefined) {
        const cacheEfficiency = renderCacheEfficiency(context.sessionHealth);
        if (cacheEfficiency) detailLines.push(cacheEfficiency);
      }
    } catch {
      // Analytics not available, skip
    }
  }

  return limitOutputLines([...outputLines, ...detailLines], config.elements.maxOutputLines).join('\n');
}
