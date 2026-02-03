#!/usr/bin/env node

/**
 * PreToolUse Hook: Sisyphus Reminder Enforcer (Node.js)
 * Injects contextual reminders before every tool execution
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

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

// Generate agent spawn message with metadata
function generateAgentSpawnMessage(toolInput, directory, todoStatus) {
  if (!toolInput || typeof toolInput !== 'object') {
    return `${todoStatus}Launch multiple agents in parallel when tasks are independent. Use run_in_background for long operations.`;
  }

  const agentType = toolInput.subagent_type || 'unknown';
  const model = toolInput.model || 'inherit';
  const desc = toolInput.description || '';
  const bg = toolInput.run_in_background ? ' [BACKGROUND]' : '';
  const tracking = getAgentTrackingInfo(directory);

  const parts = [`${todoStatus}Spawning agent: ${agentType} (${model})${bg}`];
  if (desc) parts.push(`Task: ${desc}`);
  if (tracking.running > 0) parts.push(`Active agents: ${tracking.running}`);

  return parts.join(' | ');
}

// Generate contextual message based on tool type
function generateMessage(toolName, todoStatus) {
  const messages = {
    TodoWrite: `${todoStatus}Mark todos in_progress BEFORE starting, completed IMMEDIATELY after finishing.`,
    Bash: `${todoStatus}Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).`,
    Edit: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Write: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Read: `${todoStatus}Read multiple files in parallel when possible for faster analysis.`,
    Grep: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
    Glob: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
  };

  return messages[toolName] || `${todoStatus}The boulder never stops. Continue until all tasks complete.`;
}

async function main() {
  try {
    const input = await readStdin();

    const toolName = extractJsonField(input, 'toolName', 'unknown');
    const directory = extractJsonField(input, 'directory', process.cwd());

    const todoStatus = getTodoStatus(directory);

    let message;
    if (toolName === 'Task') {
      let toolInput = null;
      try {
        toolInput = JSON.parse(input).toolInput;
      } catch {}
      message = generateAgentSpawnMessage(toolInput, directory, todoStatus);
    } else {
      message = generateMessage(toolName, todoStatus);
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
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
