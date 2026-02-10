/**
 * Rules Injector Hook
 *
 * Automatically injects relevant rule files when Claude accesses files.
 * Supports project-level (.claude/rules, .github/instructions) and
 * user-level (~/.claude/rules) rule files.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, relative, resolve } from 'path';
import { findProjectRoot, findRuleFiles } from './finder.js';
import {
  createContentHash,
  isDuplicateByContentHash,
  isDuplicateByRealPath,
  shouldApplyRule,
} from './matcher.js';
import { parseRuleFrontmatter } from './parser.js';
import {
  clearInjectedRules,
  loadInjectedRules,
  saveInjectedRules,
} from './storage.js';
import { TRACKED_TOOLS } from './constants.js';
import type { RuleToInject } from './types.js';

// Re-export all submodules
export * from './types.js';
export * from './constants.js';
export * from './finder.js';
export * from './parser.js';
export * from './matcher.js';
export * from './storage.js';

/**
 * Session cache for injected rules.
 */
interface SessionCache {
  contentHashes: Set<string>;
  realPaths: Set<string>;
}

/**
 * Create a rules injector hook for Claude Code.
 *
 * @param workingDirectory - The working directory for resolving paths
 * @returns Hook handlers for tool execution
 */
export function createRulesInjectorHook(workingDirectory: string) {
  const sessionCaches = new Map<string, SessionCache>();

  function getSessionCache(sessionId: string): SessionCache {
    if (!sessionCaches.has(sessionId)) {
      sessionCaches.set(sessionId, loadInjectedRules(sessionId));
    }
    return sessionCaches.get(sessionId)!;
  }

  function resolveFilePath(filePath: string): string | null {
    if (!filePath) return null;
    if (isAbsolute(filePath)) return filePath;
    return resolve(workingDirectory, filePath);
  }

  /**
   * Process a file path and return rules to inject.
   */
  function processFilePathForRules(
    filePath: string,
    sessionId: string
  ): RuleToInject[] {
    const resolved = resolveFilePath(filePath);
    if (!resolved) return [];

    const projectRoot = findProjectRoot(resolved);
    const cache = getSessionCache(sessionId);
    const home = homedir();

    const ruleFileCandidates = findRuleFiles(projectRoot, home, resolved);
    const toInject: RuleToInject[] = [];

    for (const candidate of ruleFileCandidates) {
      if (isDuplicateByRealPath(candidate.realPath, cache.realPaths)) continue;

      try {
        const rawContent = readFileSync(candidate.path, 'utf-8');
        const { metadata, body } = parseRuleFrontmatter(rawContent);

        let matchReason: string;
        if (candidate.isSingleFile) {
          matchReason = 'copilot-instructions (always apply)';
        } else {
          const matchResult = shouldApplyRule(metadata, resolved, projectRoot);
          if (!matchResult.applies) continue;
          matchReason = matchResult.reason ?? 'matched';
        }

        const contentHash = createContentHash(body);
        if (isDuplicateByContentHash(contentHash, cache.contentHashes)) continue;

        const relativePath = projectRoot
          ? relative(projectRoot, candidate.path)
          : candidate.path;

        toInject.push({
          relativePath,
          matchReason,
          content: body,
          distance: candidate.distance,
        });

        cache.realPaths.add(candidate.realPath);
        cache.contentHashes.add(contentHash);
      } catch {
        // Skip files that can't be read
      }
    }

    if (toInject.length > 0) {
      // Sort by distance (closest first)
      toInject.sort((a, b) => a.distance - b.distance);
      saveInjectedRules(sessionId, cache);
    }

    return toInject;
  }

  /**
   * Format rules for injection into output.
   */
  function formatRulesForInjection(rules: RuleToInject[]): string {
    if (rules.length === 0) return '';

    let output = '';
    for (const rule of rules) {
      output += `\n\n[Rule: ${rule.relativePath}]\n[Match: ${rule.matchReason}]\n${rule.content}`;
    }
    return output;
  }

  return {
    /**
     * Process a tool execution and inject rules if relevant.
     */
    processToolExecution: (
      toolName: string,
      filePath: string,
      sessionId: string
    ): string => {
      if (!TRACKED_TOOLS.includes(toolName.toLowerCase())) {
        return '';
      }

      const rules = processFilePathForRules(filePath, sessionId);
      return formatRulesForInjection(rules);
    },

    /**
     * Get rules for a specific file without marking as injected.
     */
    getRulesForFile: (filePath: string): RuleToInject[] => {
      const resolved = resolveFilePath(filePath);
      if (!resolved) return [];

      const projectRoot = findProjectRoot(resolved);
      const home = homedir();

      const ruleFileCandidates = findRuleFiles(projectRoot, home, resolved);
      const rules: RuleToInject[] = [];

      for (const candidate of ruleFileCandidates) {
        try {
          const rawContent = readFileSync(candidate.path, 'utf-8');
          const { metadata, body } = parseRuleFrontmatter(rawContent);

          let matchReason: string;
          if (candidate.isSingleFile) {
            matchReason = 'copilot-instructions (always apply)';
          } else {
            const matchResult = shouldApplyRule(metadata, resolved, projectRoot);
            if (!matchResult.applies) continue;
            matchReason = matchResult.reason ?? 'matched';
          }

          const relativePath = projectRoot
            ? relative(projectRoot, candidate.path)
            : candidate.path;

          rules.push({
            relativePath,
            matchReason,
            content: body,
            distance: candidate.distance,
          });
        } catch {
          // Skip files that can't be read
        }
      }

      return rules.sort((a, b) => a.distance - b.distance);
    },

    /**
     * Clear session cache when session ends.
     */
    clearSession: (sessionId: string): void => {
      sessionCaches.delete(sessionId);
      clearInjectedRules(sessionId);
    },

    /**
     * Check if a tool triggers rule injection.
     */
    isTrackedTool: (toolName: string): boolean => {
      return TRACKED_TOOLS.includes(toolName.toLowerCase());
    },
  };
}

/**
 * Get rules for a file path (simple utility function).
 */
export function getRulesForPath(filePath: string, workingDirectory?: string): RuleToInject[] {
  const cwd = workingDirectory || process.cwd();
  const hook = createRulesInjectorHook(cwd);
  return hook.getRulesForFile(filePath);
}
