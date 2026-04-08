#!/usr/bin/env node
// OMC Post-Tool-Use Hook (Node.js)
// Processes <remember> tags from Task agent output
// Saves to .omc/notepad.md for compaction-resilient memory

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic imports for shared modules (use pathToFileURL for Windows compatibility, #524)
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { atomicWriteFileSync } = await import(pathToFileURL(join(__dirname, 'lib', 'atomic-write.mjs')).href);

// Constants
const NOTEPAD_TEMPLATE = '# Notepad\n' +
  '<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->\n\n' +
  '## Priority Context\n' +
  '<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\n\n' +
  '## Working Memory\n' +
  '<!-- Session notes. Auto-pruned after 7 days. -->\n\n' +
  '## MANUAL\n' +
  '<!-- User content. Never auto-pruned. -->\n';

// Initialize notepad.md if needed
function initNotepad(directory) {
  const omcDir = join(directory, '.omc');
  const notepadPath = join(omcDir, 'notepad.md');

  if (!existsSync(omcDir)) {
    try { mkdirSync(omcDir, { recursive: true }); } catch {}
  }

  if (!existsSync(notepadPath)) {
    try { atomicWriteFileSync(notepadPath, NOTEPAD_TEMPLATE); } catch {}
  }

  return notepadPath;
}

function getInvokedSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSkill =
    toolInput.skill ||
    toolInput.skill_name ||
    toolInput.skillName ||
    toolInput.command ||
    null;
  if (typeof rawSkill !== 'string' || !rawSkill.trim()) return null;
  const normalized = rawSkill.trim();
  return normalized.includes(':')
    ? normalized.split(':').at(-1).toLowerCase()
    : normalized.toLowerCase();
}

function getSkillInvocationArgs(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const candidates = [
    toolInput.args,
    toolInput.arguments,
    toolInput.argument,
    toolInput.skill_args,
    toolInput.skillArgs,
    toolInput.prompt,
    toolInput.description,
    toolInput.input,
  ];
  return candidates.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || '';
}

function isConsensusPlanningSkillInvocation(skillName, toolInput) {
  if (!skillName) return false;
  if (skillName === 'ralplan') return true;
  if (skillName !== 'plan' && skillName !== 'omc-plan') return false;
  return getSkillInvocationArgs(toolInput).toLowerCase().includes('--consensus');
}

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function getSkillActiveStatePaths(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  return [
    safeSessionId ? join(stateDir, 'sessions', safeSessionId, 'skill-active-state.json') : null,
    join(stateDir, 'skill-active-state.json'),
  ].filter(Boolean);
}

function readSkillActiveState(directory, sessionId) {
  for (const statePath of getSkillActiveStatePaths(directory, sessionId)) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (state && typeof state === 'object') return state;
    } catch {}
  }
  return null;
}

function clearSkillActiveState(directory, sessionId) {
  for (const statePath of getSkillActiveStatePaths(directory, sessionId)) {
    try {
      unlinkSync(statePath);
    } catch {}
  }
}

function getRalplanStatePaths(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  return [
    safeSessionId ? join(stateDir, 'sessions', safeSessionId, 'ralplan-state.json') : null,
    join(stateDir, 'ralplan-state.json'),
  ].filter(Boolean);
}

function deactivateRalplanState(directory, sessionId) {
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const terminalPhases = new Set(['complete', 'completed', 'failed', 'cancelled', 'done']);
  const now = new Date().toISOString();

  for (const statePath of getRalplanStatePaths(directory, sessionId)) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!state || typeof state !== 'object') continue;
      if (safeSessionId && typeof state.session_id === 'string' && state.session_id !== safeSessionId) {
        continue;
      }
      const currentPhase = typeof state.current_phase === 'string' ? state.current_phase : '';
      const nextPhase = terminalPhases.has(currentPhase.toLowerCase()) ? currentPhase : 'complete';
      atomicWriteFileSync(
        statePath,
        JSON.stringify(
          {
            ...state,
            active: false,
            current_phase: nextPhase,
            completed_at: typeof state.completed_at === 'string' ? state.completed_at : now,
            deactivated_reason:
              typeof state.deactivated_reason === 'string'
                ? state.deactivated_reason
                : 'skill_completed',
          },
          null,
          2,
        ),
      );
    } catch {}
  }
}

function activateState(directory, stateName, state, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const targetDir = safeSessionId
    ? join(stateDir, 'sessions', safeSessionId)
    : stateDir;

  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    atomicWriteFileSync(join(targetDir, `${stateName}-state.json`), JSON.stringify(state, null, 2));
  } catch {}

  // Also write to global fallback
  const globalDir = join(homedir(), '.omc', 'state');
  try {
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true });
    atomicWriteFileSync(join(globalDir, `${stateName}-state.json`), JSON.stringify(state, null, 2));
  } catch {}
}

// Set priority context
function setPriorityContext(notepadPath, content) {
  try {
    let notepad = readFileSync(notepadPath, 'utf-8');

    // Find and replace Priority Context section
    const priorityMatch = notepad.match(/## Priority Context[\s\S]*?(?=## Working Memory)/);
    if (priorityMatch) {
      const newPriority = '## Priority Context\n' +
        '<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\n' +
        content.trim() + '\n\n';
      notepad = notepad.replace(priorityMatch[0], newPriority);
      atomicWriteFileSync(notepadPath, notepad);
    }
  } catch {}
}

// Add working memory entry
function addWorkingMemoryEntry(notepadPath, content) {
  try {
    let notepad = readFileSync(notepadPath, 'utf-8');

    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = '### ' + timestamp + '\n' + content.trim() + '\n\n';

    // Insert before MANUAL section
    const manualIndex = notepad.indexOf('## MANUAL');
    if (manualIndex !== -1) {
      notepad = notepad.slice(0, manualIndex) + entry + notepad.slice(manualIndex);
      atomicWriteFileSync(notepadPath, notepad);
    }
  } catch {}
}

// Process remember tags
function processRememberTags(output, notepadPath) {
  if (!output) return;

  // Process priority remember tags
  const priorityRegex = /<remember\s+priority>([\s\S]*?)<\/remember>/gi;
  let match;
  while ((match = priorityRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      setPriorityContext(notepadPath, content);
    }
  }

  // Process regular remember tags
  const regularRegex = /<remember>([\s\S]*?)<\/remember>/gi;
  while ((match = regularRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      addWorkingMemoryEntry(notepadPath, content);
    }
  }
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    // Official SDK fields (snake_case) with legacy fallback
    const toolName = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.toolInput || {};
    // tool_response may be string or object — normalize to string for .includes() check
    const rawResponse = data.tool_response || data.toolOutput || '';
    const toolOutput = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || data.sessionid || '';

    // Handle Skill("...:ralph") invocations so ralph handoffs activate persistent states.
    if (String(toolName).toLowerCase() === 'skill') {
      const skillName = getInvokedSkillName(toolInput);
      const currentState = readSkillActiveState(directory, sessionId);
      const completingSkill = (skillName || '').replace(/^oh-my-claudecode:/, '');
      if (!currentState || !currentState.active || currentState.skill_name === completingSkill) {
        clearSkillActiveState(directory, sessionId);
      }
      if (isConsensusPlanningSkillInvocation(skillName, toolInput)) {
        deactivateRalplanState(directory, sessionId);
      }
      if (skillName === 'ralph') {
        const now = new Date().toISOString();
        const promptText = data.prompt || data.message || 'Ralph loop activated via Skill tool';
        activateState(directory, 'ralph', {
          active: true,
          iteration: 1,
          max_iterations: 100,
          started_at: now,
          prompt: promptText,
          session_id: sessionId || undefined,
          project_path: directory,
          linked_ultrawork: true
        }, sessionId);
        activateState(directory, 'ultrawork', {
          active: true,
          started_at: now,
          original_prompt: promptText,
          session_id: sessionId || undefined,
          project_path: directory,
          reinforcement_count: 0,
          last_checked_at: now,
          linked_to_ralph: true
        }, sessionId);
      }
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Only process Task tool output
    if (
      toolName !== 'Task' &&
      toolName !== 'task' &&
      toolName !== 'TaskCreate' &&
      toolName !== 'TaskUpdate'
    ) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Check for remember tags
    if (!toolOutput.includes('<remember')) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Initialize notepad and process tags
    const notepadPath = initNotepad(directory);
    processRememberTags(toolOutput, notepadPath);

    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
