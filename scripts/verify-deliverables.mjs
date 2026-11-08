#!/usr/bin/env node

/**
 * OMC Deliverable Verification Hook (SubagentStop)
 *
 * Checks that completing agents actually produced their expected deliverables.
 * A task can be marked "completed" with zero output files — this hook catches
 * that gap by verifying file existence and minimum content.
 *
 * Deliverable requirements are loaded from (in priority order):
 *   1. .omc/deliverables.json (project-specific overrides)
 *   2. ${CLAUDE_PLUGIN_ROOT}/templates/deliverables.json (OMC defaults)
 *
 * This hook is ADVISORY (non-blocking) and never prevents the agent from
 * stopping. Because it runs on SubagentStop, it does NOT emit
 * hookSpecificOutput.additionalContext: that context would be reinjected into
 * the finishing subagent (the regression fixed in #3209 / #3233). It always
 * suppresses its own output.
 *
 * Hook output:
 *   - { continue: true, suppressOutput: true } in all cases (deliverables
 *     missing, all checks pass, or on error)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, isAbsolute, resolve } from 'node:path';
import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

/**
 * Sanitize a file path to prevent directory traversal attacks.
 * Rejects absolute paths and paths containing '..' segments.
 */
function sanitizePath(filePath) {
  const normalized = normalize(filePath);
  if (isAbsolute(normalized) || normalized.startsWith('..')) {
    return null;
  }
  return normalized;
}

/**
 * Load deliverable requirements from project config or OMC defaults.
 */
function loadDeliverableConfig(directory, omcRoot) {
  const _omcRoot = omcRoot;
  // Priority 1: Project-specific overrides
  const projectConfig = join(_omcRoot, 'deliverables.json');
  if (existsSync(projectConfig)) {
    try {
      return JSON.parse(readFileSync(projectConfig, 'utf-8'));
    } catch { /* fall through to defaults */ }
  }

  // Priority 2: OMC defaults
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const defaultConfig = join(pluginRoot, 'templates', 'deliverables.json');
    if (existsSync(defaultConfig)) {
      try {
        return JSON.parse(readFileSync(defaultConfig, 'utf-8'));
      } catch { /* fall through */ }
    }
  }

  return null;
}

/**
 * Determine the current team stage from OMC state.
 */
function detectStage(directory, sessionId, omcRoot) {
  const _omcRoot = omcRoot;
  // Try session-scoped state first
  if (sessionId) {
    const sessionState = join(_omcRoot, 'state', 'sessions', sessionId, 'team-state.json');
    if (existsSync(sessionState)) {
      try {
        const data = JSON.parse(readFileSync(sessionState, 'utf-8'));
        return data.current_phase || data.currentPhase || null;
      } catch { /* fall through */ }
    }
  }

  // Fallback to legacy state
  const legacyState = join(_omcRoot, 'state', 'team-state.json');
  if (existsSync(legacyState)) {
    try {
      const data = JSON.parse(readFileSync(legacyState, 'utf-8'));
      return data.current_phase || data.currentPhase || null;
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Check if a file exists and meets minimum size requirements.
 */
function checkFile(directory, filePath, minSize = 200) {
  const safePath = sanitizePath(filePath);
  if (!safePath) return { exists: false, path: filePath, reason: 'invalid path (traversal blocked)' };

  const fullPath = join(directory, safePath);
  if (!existsSync(fullPath)) {
    return { exists: false, path: filePath, reason: 'file not found' };
  }

  try {
    const stat = statSync(fullPath);
    if (stat.size < minSize) {
      return { exists: true, path: filePath, reason: `file too small (${stat.size} bytes, minimum ${minSize})` };
    }
  } catch {
    return { exists: true, path: filePath, reason: 'cannot read file stats' };
  }

  return null; // passes
}

/**
 * Check if a file contains required patterns (e.g., PASS/FAIL verdict).
 */
function checkPatterns(directory, filePath, patterns) {
  if (!patterns || patterns.length === 0) return null;

  const safePath = sanitizePath(filePath);
  if (!safePath) return null;

  const fullPath = join(directory, safePath);
  if (!existsSync(fullPath)) return null; // file check handles this

  try {
    const content = readFileSync(fullPath, 'utf-8');
    for (const pattern of patterns) {
      const regex = new RegExp(pattern);
      if (!regex.test(content)) {
        return { path: filePath, reason: `missing required pattern: ${pattern}` };
      }
    }
  } catch {
    return { path: filePath, reason: 'cannot read file for pattern check' };
  }

  return null; // passes
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const omcRoot = await resolveOmcStateRoot(directory);

    // Load deliverable config
    const config = loadDeliverableConfig(directory, omcRoot);
    if (!config) {
      // No config found — nothing to verify
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Detect current stage
    const stage = detectStage(directory, sessionId, omcRoot);
    if (!stage) {
      // No team stage detected — skip verification
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Get requirements for this stage
    const requirements = config[stage];
    if (!requirements || !requirements.files || requirements.files.length === 0) {
      // No deliverables required for this stage
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Check each required file
    const issues = [];
    const minSize = requirements.minSize || 200;

    for (const filePath of requirements.files) {
      const fileIssue = checkFile(directory, filePath, minSize);
      if (fileIssue) issues.push(fileIssue);

      // Check required patterns if file exists
      if (!fileIssue && requirements.requiredPatterns) {
        const patternIssue = checkPatterns(directory, filePath, requirements.requiredPatterns);
        if (patternIssue) issues.push(patternIssue);
      }
    }

    // Check required sections in files
    if (requirements.requiredSections) {
      for (const filePath of requirements.files) {
        const safePath = sanitizePath(filePath);
        if (!safePath) continue;
        const fullPath = join(directory, safePath);
        if (existsSync(fullPath)) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            for (const section of requirements.requiredSections) {
              if (!content.includes(section)) {
                issues.push({ path: filePath, reason: `missing required section: ${section}` });
              }
            }
          } catch { /* skip */ }
        }
      }
    }

    if (issues.length === 0) {
      // All checks pass
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Deliverables are missing or incomplete. Do NOT emit
    // hookSpecificOutput.additionalContext here: this hook runs on
    // SubagentStop, and additionalContext would be reinjected into the
    // finishing subagent's context (the regression fixed in #3209 for
    // subagent-tracker). Suppress output and let the agent stop instead.
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch {
    // On any error, allow the agent to stop (never block on hook failure)
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
