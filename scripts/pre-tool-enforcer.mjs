#!/usr/bin/env node

/**
 * PreToolUse Hook: OMC Reminder Enforcer (Node.js)
 * Injects contextual reminders before every tool execution
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readStdin } from './lib/stdin.mjs';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const MODE_STATE_FILES = [
  'autopilot-state.json',
  'ultrapilot-state.json',
  'ralph-state.json',
  'ultrawork-state.json',
  'ultraqa-state.json',
  'pipeline-state.json',
  'team-state.json',
];

// Simple JSON field extraction
function extractJsonField(input, field, defaultValue = '') {
  try {
    const data = JSON.parse(input);
    return data[field] ?? defaultValue;
  } catch {
    // Fallback regex extraction
    const match = input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i'));
    return match ? match[1] : defaultValue;
  }
}

// Get agent tracking info from state file
function getAgentTrackingInfo(directory) {
  const trackingFile = join(directory, '.omc', 'state', 'subagent-tracking.json');
  try {
    if (existsSync(trackingFile)) {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const running = (data.agents || []).filter(a => a.status === 'running').length;
      return { running, total: data.total_spawned || 0 };
    }
  } catch {}
  return { running: 0, total: 0 };
}

// Get todo status from project-local todos only
function getTodoStatus(directory) {
  let pending = 0;
  let inProgress = 0;

  // Check project-local todos
  const localPaths = [
    join(directory, '.omc', 'todos.json'),
    join(directory, '.claude', 'todos.json')
  ];

  for (const todoFile of localPaths) {
    if (existsSync(todoFile)) {
      try {
        const content = readFileSync(todoFile, 'utf-8');
        const data = JSON.parse(content);
        const todos = data.todos || data;
        if (Array.isArray(todos)) {
          pending += todos.filter(t => t.status === 'pending').length;
          inProgress += todos.filter(t => t.status === 'in_progress').length;
        }
      } catch {
        // Ignore errors
      }
    }
  }

  // NOTE: We intentionally do NOT scan the global ~/.claude/todos/ directory.
  // That directory accumulates todo files from ALL past sessions across all
  // projects, causing phantom task counts in fresh sessions (see issue #354).

  if (pending + inProgress > 0) {
    return `[${inProgress} active, ${pending} pending] `;
  }

  return '';
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasActiveJsonMode(stateDir, { allowSessionTagged = false } = {}) {
  for (const file of MODE_STATE_FILES) {
    const state = readJsonFile(join(stateDir, file));
    if (!state || state.active !== true) continue;
    if (!allowSessionTagged && state.session_id) continue;
    return true;
  }
  return false;
}

function hasActiveSwarmMode(stateDir, { allowSessionTagged = false } = {}) {
  const markerFile = join(stateDir, 'swarm-active.marker');
  if (!existsSync(markerFile)) return false;

  const summary = readJsonFile(join(stateDir, 'swarm-summary.json'));
  if (!summary || summary.active !== true) return false;
  if (!allowSessionTagged && summary.session_id) return false;

  return true;
}

function hasActiveMode(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');

  if (isValidSessionId(sessionId)) {
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    return (
      hasActiveJsonMode(sessionStateDir, { allowSessionTagged: true }) ||
      hasActiveSwarmMode(sessionStateDir, { allowSessionTagged: true })
    );
  }

  return (
    hasActiveJsonMode(stateDir, { allowSessionTagged: false }) ||
    hasActiveSwarmMode(stateDir, { allowSessionTagged: false })
  );
}

/**
 * Check if team mode is active for the given directory/session.
 * Reads team-state.json from session-scoped or legacy paths.
 * Returns the team state object if active, null otherwise.
 */
function getActiveTeamState(directory, sessionId) {
  const paths = [];

  // Session-scoped path (preferred)
  if (sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    paths.push(join(directory, '.omc', 'state', 'sessions', sessionId, 'team-state.json'));
  }

  // Legacy path
  paths.push(join(directory, '.omc', 'state', 'team-state.json'));

  for (const statePath of paths) {
    const state = readJsonFile(statePath);
    if (state && state.active === true) {
      // Respect session isolation: skip state tagged to a different session
      if (sessionId && state.session_id && state.session_id !== sessionId) {
        continue;
      }
      return state;
    }
  }
  return null;
}

// Generate agent spawn message with metadata
function generateAgentSpawnMessage(toolInput, directory, todoStatus, sessionId) {
  if (!toolInput || typeof toolInput !== 'object') {
    return `${todoStatus}Launch multiple agents in parallel when tasks are independent. Use run_in_background for long operations.`;
  }

  const agentType = toolInput.subagent_type || 'unknown';
  const model = toolInput.model || 'inherit';
  const desc = toolInput.description || '';
  const bg = toolInput.run_in_background ? ' [BACKGROUND]' : '';
  const tracking = getAgentTrackingInfo(directory);

  // Team-routing enforcement (issue #1006):
  // When team state is active and Task is called WITHOUT team_name,
  // inject a redirect message to use team agents instead of subagents.
  const teamState = getActiveTeamState(directory, sessionId);
  if (teamState && !toolInput.team_name) {
    const teamName = teamState.team_name || teamState.teamName || 'team';
    return `[TEAM ROUTING REQUIRED] Team "${teamName}" is active but you are spawning a regular subagent ` +
      `without team_name. You MUST use TeamCreate first (if not already created), then spawn teammates with ` +
      `Task(team_name="${teamName}", name="worker-N", subagent_type="${agentType}"). ` +
      `Do NOT use Task without team_name during an active team session. ` +
      `If TeamCreate is not available in your tools, tell the user to verify ` +
      `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is set in ~/.claude/settings.json and restart Claude Code.`;
  }

  const parts = [`${todoStatus}Spawning agent: ${agentType} (${model})${bg}`];
  if (desc) parts.push(`Task: ${desc}`);
  if (tracking.running > 0) parts.push(`Active agents: ${tracking.running}`);

  return parts.join(' | ');
}

// Generate contextual message based on tool type
function generateMessage(toolName, todoStatus, modeActive = false) {
  const messages = {
    TodoWrite: `${todoStatus}Mark todos in_progress BEFORE starting, completed IMMEDIATELY after finishing.`,
    Bash: `${todoStatus}Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).`,
    Edit: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Write: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Read: `${todoStatus}Read multiple files in parallel when possible for faster analysis.`,
    Grep: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
    Glob: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
  };

  if (messages[toolName]) return messages[toolName];
  if (modeActive) return `${todoStatus}The boulder never stops. Continue until all tasks complete.`;
  return '';
}

// Record Skill/Task invocations to flow trace (best-effort)
async function recordToolInvocation(data, directory) {
  try {
    const toolName = data.toolName || data.tool_name || '';
    const sessionId = data.session_id || data.sessionId || '';
    if (!sessionId || !directory) return;

    if (toolName === 'Skill') {
      const skillName = data.toolInput?.skill || data.tool_input?.skill || '';
      if (skillName) {
        const { recordSkillInvoked } = await import('../dist/hooks/subagent-tracker/flow-tracer.js');
        recordSkillInvoked(directory, sessionId, skillName);
      }
    }
  } catch { /* best-effort, never block tool execution */ }
}

async function main() {
  // Skip guard: check OMC_SKIP_HOOKS env var (see issue #838)
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || _skipHooks.includes('pre-tool-use')) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();

    const toolName = extractJsonField(input, 'tool_name') || extractJsonField(input, 'toolName', 'unknown');
    const directory = extractJsonField(input, 'cwd') || extractJsonField(input, 'directory', process.cwd());

    // Record Skill invocations to flow trace
    let data = {};
    try { data = JSON.parse(input); } catch {}
    recordToolInvocation(data, directory);

    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : typeof data.sessionId === 'string'
          ? data.sessionId
          : '';
    const modeActive = hasActiveMode(directory, sessionId);

    // Send notification when AskUserQuestion is about to execute (user input needed)
    // Fires in PreToolUse so users get notified BEFORE the tool blocks for input (#597)
    if (toolName === 'AskUserQuestion') {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        if (pluginRoot) {
          const { notify } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href);

          const toolInput = data.toolInput || data.tool_input || {};
          const questions = toolInput.questions || [];
          const questionText = questions.map(q => q.question || '').filter(Boolean).join('; ') || 'User input requested';
          const sessionId = data.session_id || data.sessionId || '';

          // Fire and forget - don't block tool execution
          notify('ask-user-question', {
            sessionId,
            projectPath: directory,
            question: questionText,
          }).catch(() => {});
        }
      } catch {
        // Notification not available, skip
      }
    }

    const todoStatus = getTodoStatus(directory);

    let message;
    if (toolName === 'Task' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
      const toolInput = data.toolInput || data.tool_input || null;
      message = generateAgentSpawnMessage(toolInput, directory, todoStatus, sessionId);
    } else {
      message = generateMessage(toolName, todoStatus, modeActive);
    }

    if (!message) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message
      }
    }, null, 2));
  } catch (error) {
    // On error, always continue
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
