#!/usr/bin/env node

/**
 * Contribution Guard for OMC project.
 * Enforces contribution guidelines via PreToolUse hook.
 *
 * P0 (deny): Wrong base branch on `gh pr create`
 * P1 (warn): Non-conventional commit messages, missing PR sections
 *
 * Only activates when working inside the OMC repo itself
 * (checked via .claude-plugin/plugin.json name).
 * Does NOT activate when OMC is installed as a plugin in another project.
 *
 * Disable with: OMC_SKIP_CONTRIBUTION_GUARD=1
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Check if the working directory is the OMC project itself.
 * Uses .claude-plugin/plugin.json with name "oh-my-claudecode" as the canonical check.
 */
function isOmcProject(directory) {
  try {
    const pluginJsonPath = join(directory, '.claude-plugin', 'plugin.json');
    if (!existsSync(pluginJsonPath)) return false;
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson?.name === 'oh-my-claudecode';
  } catch {
    return false;
  }
}

/**
 * Check contribution guide compliance for a tool invocation.
 *
 * @param {string} toolName - The tool being invoked (e.g., 'Bash')
 * @param {object} toolInput - The tool's input parameters
 * @param {string} directory - The working directory
 * @returns {{ type: 'deny', reason: string } | { type: 'warn', message: string } | null}
 */
export function checkContributionGuard(toolName, toolInput, directory) {
  if (process.env.OMC_SKIP_CONTRIBUTION_GUARD === '1') return null;
  if (toolName !== 'Bash') return null;
  if (!isOmcProject(directory)) return null;

  const command = toolInput?.command || '';

  // Honor inline env var bypass: OMC_SKIP_CONTRIBUTION_GUARD=1 gh pr create ...
  // Anchored to ^ with optional env-prefix list (e.g. GH_TOKEN=xxx VAR=1 ...)
  if (/^\s*(\w+=\S*\s+)*OMC_SKIP_CONTRIBUTION_GUARD=1\s+gh\s+pr\s+create\b/.test(command)) return null;

  // P0: Check gh pr create base branch
  // Use \b word boundary to catch all common shell forms:
  // leading whitespace, newlines, subshells, env prefixes, chained commands
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    // Strip --body arguments to prevent matching --base inside body text
    const commandWithoutBody = command.replace(/--body[=\s]+["'][\s\S]*?["']/g, '');
    // Match both --base and -B (GitHub CLI shorthand)
    const baseMatch = commandWithoutBody.match(/(?:--base|-B)[=\s]+(\S+)/);
    if (baseMatch) {
      const baseBranch = baseMatch[1].replace(/['"();|&\n]/g, '');
      if (baseBranch === 'main' || baseBranch === 'master') {
        return {
          type: 'deny',
          reason: `[CONTRIBUTION GUARD - P0] PRs must target \`dev\` branch, not \`${baseBranch}\`. ` +
            `Change --base ${baseBranch} to --base dev. ` +
            `See CONTRIBUTING.md for branch policy details.`
        };
      }
    } else if (!commandWithoutBody.match(/(?:--base|-B)\b/)) {
      return {
        type: 'deny',
        reason: `[CONTRIBUTION GUARD - P0] Missing --base flag. PRs must target \`dev\` branch. ` +
          `Add \`--base dev\` to your gh pr create command. ` +
          `GitHub defaults to \`main\` which is the release branch, not the development branch.`
      };
    }

    // P1: Check PR body for required sections
    const bodyMatch = command.match(/--body[=\s]+["']([\s\S]*?)["']/);
    if (bodyMatch) {
      const body = bodyMatch[1];
      const missingSections = [];
      if (!/##\s*[Ss]ummary/.test(body)) missingSections.push('## Summary');
      if (!/##\s*[Tt]est/.test(body)) missingSections.push('## Test plan');
      if (missingSections.length > 0) {
        return {
          type: 'warn',
          message: `[CONTRIBUTION GUIDE - P1] PR body is missing required sections: ${missingSections.join(', ')}. ` +
            `PRs should include ## Summary and ## Test plan sections. See CONTRIBUTING.md.`
        };
      }
    }
  }

  // P1: Check commit message format
  // Use \b word boundary to catch all common shell forms
  if (/\bgit\s+commit\b/.test(command)) {
    const msgMatch = command.match(/-m\s+["']([^"']*?)["']/);
    if (msgMatch) {
      const msg = msgMatch[1];
      const conventionalPattern = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([^)]+\))?!?:\s/;
      if (!conventionalPattern.test(msg)) {
        return {
          type: 'warn',
          message: `[CONTRIBUTION GUIDE - P1] Commit message should follow conventional commits: type(scope): description. ` +
            `Types: feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert. ` +
            `Example: "fix(hooks): prevent wrong base branch in PR creation"`
        };
      }
    }
  }

  return null;
}
