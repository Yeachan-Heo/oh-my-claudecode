/**
 * OMC HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */

import type { HudRenderContext, HudConfig } from './types.js';
import { bold, dim } from './colors.js';
import { renderRalph } from './elements/ralph.js';
import { renderAgentsByFormat, renderAgentsMultiLine } from './elements/agents.js';
import { renderTodosWithCurrent } from './elements/todos.js';
import { renderSkills, renderLastSkill } from './elements/skills.js';
import { renderContext } from './elements/context.js';
import { renderBackground } from './elements/background.js';
import { renderPrd } from './elements/prd.js';
import { renderRateLimits } from './elements/limits.js';
import { renderPermission } from './elements/permission.js';
import { renderThinking } from './elements/thinking.js';
import { renderSession } from './elements/session.js';

/**
 * Render the complete statusline (single or multi-line)
 */
export function render(context: HudRenderContext, config: HudConfig): string {
  const elements: string[] = [];
  const detailLines: string[] = [];
  const { elements: enabledElements } = config;

  // [OMC] label
  if (enabledElements.omcLabel) {
    elements.push(bold('[OMC]'));
  }

  // Rate limits (5h and weekly)
  if (enabledElements.rateLimits && context.rateLimits) {
    const limits = renderRateLimits(context.rateLimits);
    if (limits) elements.push(limits);
  }

  // Permission status indicator (heuristic-based)
  if (enabledElements.permissionStatus && context.pendingPermission) {
    const permission = renderPermission(context.pendingPermission);
    if (permission) elements.push(permission);
  }

  // Extended thinking indicator
  if (enabledElements.thinking && context.thinkingState) {
    const thinking = renderThinking(context.thinkingState);
    if (thinking) elements.push(thinking);
  }

  // Session health indicator
  if (enabledElements.sessionHealth && context.sessionHealth) {
    const session = renderSession(context.sessionHealth);
    if (session) elements.push(session);
  }

  // Ralph loop state
  if (enabledElements.ralph && context.ralph) {
    const ralph = renderRalph(context.ralph, config.thresholds);
    if (ralph) elements.push(ralph);
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
    const ctx = renderContext(context.contextPercent, config.thresholds);
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

  // Compose output
  const headerLine = elements.join(dim(' | '));

  // Todos on second line (if available)
  if (enabledElements.todos) {
    const todos = renderTodosWithCurrent(context.todos);
    if (todos) detailLines.push(todos);
  }

  // If we have detail lines, output multi-line
  if (detailLines.length > 0) {
    return [headerLine, ...detailLines].join('\n');
  }

  return headerLine;
}
