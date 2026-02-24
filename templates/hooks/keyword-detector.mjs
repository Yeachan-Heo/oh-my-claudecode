#!/usr/bin/env node

/**
 * OMC Keyword Detector Hook (Node.js)
 * Detects magic keywords and invokes skill tools
 * Cross-platform: Windows, macOS, Linux
 *
 * Supported keywords (in priority order):
 * 1. cancelomc/stopomc: Stop active modes
 * 2. ralph: Persistence mode until task completion
 * 3. autopilot: Full autonomous execution
 * 4. team: Coordinated team execution
 * 5. ultrawork/ulw: Maximum parallel execution
* 6. pipeline: Sequential agent chaining
 * 7. ralplan: Iterative planning with consensus
 * 8. plan: Planning interview mode
 * 9. tdd: Test-driven development
 * 10. ultrathink: Extended reasoning
 * 11. deepsearch: Codebase search (restricted patterns)
 * 12. analyze: Analysis mode (restricted patterns)
 * 13. ccg: Claude-Codex-Gemini tri-model orchestration
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module (use pathToFileURL for Windows compatibility, #524)
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);

const ULTRATHINK_MESSAGE = `<think-mode>

**ULTRATHINK MODE ENABLED** - Extended reasoning activated.

You are now in deep thinking mode. Take your time to:
1. Thoroughly analyze the problem from multiple angles
2. Consider edge cases and potential issues
3. Think through the implications of each approach
4. Reason step-by-step before acting

Use your extended thinking capabilities to provide the most thorough and well-reasoned response.

</think-mode>

---
`;

// Extract prompt from various JSON structures
function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    return '';
  } catch {
    // Fail closed: don't risk false-positive keyword detection from malformed input
    return '';
  }
}

// Sanitize text to prevent false positives from code blocks, XML tags, URLs, and file paths
function sanitizeForKeywordDetection(text) {
  return text
    // 1. Strip XML-style tag blocks: <tag-name ...>...</tag-name> (multi-line, greedy on tag name)
    .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '')
    // 2. Strip self-closing XML tags: <tag-name />, <tag-name attr="val" />
    .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '')
    // 3. Strip URLs: http://... or https://... up to whitespace
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    // 4. Strip file paths: /foo/bar/baz or foo/bar/baz — uses lookbehind (Node.js supports it)
    // The TypeScript version (index.ts) uses capture group + $1 replacement for broader compat
    .replace(/(?<=^|[\s"'`(])(?:\/)?(?:[\w.-]+\/)+[\w.-]+/gm, '')
    // 5. Strip markdown code blocks (existing)
    .replace(/```[\s\S]*?```/g, '')
    // 6. Strip inline code (existing)
    .replace(/`[^`]+`/g, '');
}

// Create state file for a mode
function activateState(directory, prompt, stateName, sessionId) {
  const state = {
    active: true,
    started_at: new Date().toISOString(),
    original_prompt: prompt,
    session_id: sessionId || undefined,
    reinforcement_count: 0,
    last_checked_at: new Date().toISOString()
  };

  // Write to local .omc/state directory
  const localDir = join(directory, '.omc', 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(localDir, `${stateName}-state.json`), JSON.stringify(state, null, 2)); } catch {}

  // Write to global .omc/state directory
  const globalDir = join(homedir(), '.omc', 'state');
  if (!existsSync(globalDir)) {
    try { mkdirSync(globalDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(globalDir, `${stateName}-state.json`), JSON.stringify(state, null, 2)); } catch {}
}

/**
 * Clear state files for cancel operation
 */
function clearStateFiles(directory, modeNames) {
  for (const name of modeNames) {
    const localPath = join(directory, '.omc', 'state', `${name}-state.json`);
    const globalPath = join(homedir(), '.omc', 'state', `${name}-state.json`);
    try { if (existsSync(localPath)) unlinkSync(localPath); } catch {}
    try { if (existsSync(globalPath)) unlinkSync(globalPath); } catch {}
  }
}

/**
 * Link ralph and team state files for composition.
 * Updates both state files to reference each other.
 */
function linkRalphTeam(directory, sessionId) {
  const getStatePath = (modeName) => {
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      return join(directory, '.omc', 'state', 'sessions', sessionId, `${modeName}-state.json`);
    }
    return join(directory, '.omc', 'state', `${modeName}-state.json`);
  };

  // Update ralph state with linked_team
  try {
    const ralphPath = getStatePath('ralph');
    if (existsSync(ralphPath)) {
      const state = JSON.parse(readFileSync(ralphPath, 'utf-8'));
      state.linked_team = true;
      writeFileSync(ralphPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  } catch { /* silent */ }

  // Update team state with linked_ralph
  try {
    const teamPath = getStatePath('team');
    if (existsSync(teamPath)) {
      const state = JSON.parse(readFileSync(teamPath, 'utf-8'));
      state.linked_ralph = true;
      writeFileSync(teamPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  } catch { /* silent */ }
}

/**
 * Create a skill invocation message that tells Claude to use the Skill tool
 */
function createSkillInvocation(skillName, originalPrompt, args = '') {
  const argsSection = args ? `\nArguments: ${args}` : '';
  return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]

You MUST invoke the skill using the Skill tool:

Skill: oh-my-claudecode:${skillName}${argsSection}

User request:
${originalPrompt}

IMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.`;
}

/**
 * Create multi-skill invocation message for combined keywords
 */
function createMultiSkillInvocation(skills, originalPrompt) {
  if (skills.length === 0) return '';
  if (skills.length === 1) {
    return createSkillInvocation(skills[0].name, originalPrompt, skills[0].args);
  }

  const skillBlocks = skills.map((s, i) => {
    const argsSection = s.args ? `\nArguments: ${s.args}` : '';
    return `### Skill ${i + 1}: ${s.name.toUpperCase()}
Skill: oh-my-claudecode:${s.name}${argsSection}`;
  }).join('\n\n');

  return `[MAGIC KEYWORDS DETECTED: ${skills.map(s => s.name.toUpperCase()).join(', ')}]

You MUST invoke ALL of the following skills using the Skill tool, in order:

${skillBlocks}

User request:
${originalPrompt}

IMPORTANT: Invoke ALL skills listed above. Start with the first skill IMMEDIATELY. After it completes, invoke the next skill in order. Do not skip any skill.`;
}

/**
 * Create combined output for multiple skill matches
 */
function createCombinedOutput(skillMatches, originalPrompt) {
  const parts = [];
  if (skillMatches.length > 0) {
    parts.push('## Section 1: Skill Invocations\n\n' + createMultiSkillInvocation(skillMatches, originalPrompt));
  }
  const allNames = skillMatches.map(m => m.name.toUpperCase());
  return `[MAGIC KEYWORDS DETECTED: ${allNames.join(', ')}]\n\n${parts.join('\n\n---\n\n')}\n\nIMPORTANT: Complete ALL sections above in order.`;
}

/**
 * Resolve conflicts between detected keywords
 */
function resolveConflicts(matches) {
  const names = matches.map(m => m.name);

  // Cancel is exclusive
  if (names.includes('cancel')) {
    return [matches.find(m => m.name === 'cancel')];
  }

  let resolved = [...matches];

  // Team beats autopilot (legacy ultrapilot semantics)
  if (names.includes('team') && names.includes('autopilot')) {
    resolved = resolved.filter(m => m.name !== 'autopilot');
  }

  // Team beats ultrapilot (team is the canonical implementation)
  if (names.includes('team') && names.includes('ultrapilot')) {
    resolved = resolved.filter(m => m.name !== 'ultrapilot');
  }

  // Ralph + Team coexist (team-ralph linked mode)
  // Both keywords are preserved so the skill can detect the composition.

  // Sort by priority order
const priorityOrder = ['cancel','ralph','autopilot','team','ultrawork',
    'pipeline','ccg','ralplan','plan','tdd','research','ultrathink','deepsearch','analyze'];
  resolved.sort((a, b) => priorityOrder.indexOf(a.name) - priorityOrder.indexOf(b.name));

  return resolved;
}

/**
 * Create proper hook output with additionalContext (Claude Code hooks API)
 * The 'message' field is NOT a valid hook output - use hookSpecificOutput.additionalContext
 */
function createHookOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  };
}

/**
 * Check if the team feature is enabled in Claude Code settings.
 * Reads ~/.claude/settings.json and checks for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var.
 * @returns {boolean} true if team feature is enabled
 */
function isTeamEnabled() {
  try {
    // Check settings.json first (authoritative, user-controlled)
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(cfgDir, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1' ||
          settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 'true') {
        return true;
      }
    }
    // Fallback: check env var (for dev/CI environments)
    if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1' ||
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 'true') {
      return true;
    }
    return false;
  } catch { return false; }
}

// Main
async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const cleanPrompt = sanitizeForKeywordDetection(prompt).toLowerCase();

    // Collect all matching keywords
    const matches = [];

    // Cancel keywords
    if (/\b(cancelomc|stopomc)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'cancel', args: '' });
    }

    // Ralph keywords
    if (/\b(ralph)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ralph', args: '' });
    }

    // Autopilot keywords
    if (/\b(autopilot|auto[\s-]?pilot|fullsend|full\s+auto)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'autopilot', args: '' });
    }

    // Team keywords (intent-gated to prevent false positives on bare "team")
    // Uses negative lookbehind to exclude possessive/article contexts like "my team", "the team"
    const hasTeamKeyword = /(?<!\b(?:my|the|our|a|his|her|their|its)\s)\bteam\b/i.test(cleanPrompt) ||
      /\bcoordinated\s+team\b/i.test(cleanPrompt);
    if (hasTeamKeyword && isTeamEnabled()) {
      matches.push({ name: 'team', args: '' });
    }

    // Ultrawork keywords
    if (/\b(ultrawork|ulw)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrawork', args: '' });
    }

    // Pipeline keywords
    if (/\bagent\s+pipeline\b/i.test(cleanPrompt) || /\bchain\s+agents\b/i.test(cleanPrompt)) {
      matches.push({ name: 'pipeline', args: '' });
    }

    // CCG keywords (Claude-Codex-Gemini tri-model orchestration)
    if (/\b(ccg|claude-codex-gemini)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ccg', args: '' });
    }

    // Ralplan keyword
    if (/\b(ralplan)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ralplan', args: '' });
    }

    // TDD keywords
    if (/\b(tdd)\b/i.test(cleanPrompt) ||
        /\btest\s+first\b/i.test(cleanPrompt)) {
      matches.push({ name: 'tdd', args: '' });
    }

    // Ultrathink keywords
    if (/\b(ultrathink)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrathink', args: '' });
    }

    // Deepsearch keywords
    if (/\b(deepsearch)\b/i.test(cleanPrompt) ||
        /\bsearch\s+the\s+codebase\b/i.test(cleanPrompt) ||
        /\bfind\s+in\s+(the\s+)?codebase\b/i.test(cleanPrompt)) {
      matches.push({ name: 'deepsearch', args: '' });
    }

    // Analyze keywords
    if (/\b(deep[\s-]?analyze|deepanalyze)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'analyze', args: '' });
    }

    // No matches - pass through
    if (matches.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Deduplicate matches by keyword name before conflict resolution
    const seen = new Set();
    const uniqueMatches = [];
    for (const m of matches) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        uniqueMatches.push(m);
      }
    }

    // Resolve conflicts
    const resolved = resolveConflicts(uniqueMatches);

    // Handle cancel specially - clear states and emit
    if (resolved.length > 0 && resolved[0].name === 'cancel') {
      clearStateFiles(directory, ['ralph', 'autopilot', 'team', 'ultrawork', 'pipeline']);
      console.log(JSON.stringify(createHookOutput(createSkillInvocation('cancel', prompt))));
      return;
    }

    // Activate states for modes that need them
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const stateModes = resolved.filter(m => ['ralph', 'autopilot', 'team', 'ultrawork'].includes(m.name));
    for (const mode of stateModes) {
      activateState(directory, prompt, mode.name, sessionId);
    }

    // Special: Ralph with ultrawork (ralph always includes ultrawork)
    const hasRalph = resolved.some(m => m.name === 'ralph');
    const hasUltrawork = resolved.some(m => m.name === 'ultrawork');
    const hasTeam = resolved.some(m => m.name === 'team');
    if (hasRalph && !hasUltrawork) {
      activateState(directory, prompt, 'ultrawork', sessionId);
    }

    // Link ralph + team if both detected (team-ralph composition)
    if (hasRalph && hasTeam) {
      linkRalphTeam(directory, sessionId);
    }

    // Handle ultrathink specially - prepend message instead of skill invocation
    const ultrathinkIndex = resolved.findIndex(m => m.name === 'ultrathink');
    if (ultrathinkIndex !== -1) {
      // Remove ultrathink from skill list
      resolved.splice(ultrathinkIndex, 1);

      // If ultrathink was the only match, emit message
      if (resolved.length === 0) {
        console.log(JSON.stringify(createHookOutput(ULTRATHINK_MESSAGE)));
        return;
      }

      // Otherwise, prepend ultrathink message to skill invocation
      const skillMessage = createMultiSkillInvocation(resolved, prompt);
      console.log(JSON.stringify(createHookOutput(ULTRATHINK_MESSAGE + skillMessage)));
      return;
    }

    const skillMatches = resolved;
    if (skillMatches.length > 0) {
      console.log(JSON.stringify(createHookOutput(createMultiSkillInvocation(skillMatches, prompt))));
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
