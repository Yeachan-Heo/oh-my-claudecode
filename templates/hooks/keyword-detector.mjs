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
 * 6. ecomode/eco: Token-efficient execution
 * 7. pipeline: Sequential agent chaining
 * 8. ralplan: Iterative planning with consensus
 * 9. plan: Planning interview mode
 * 10. tdd: Test-driven development
 * 11. research: Research orchestration
 * 12. ultrathink/think: Extended reasoning
 * 13. deepsearch: Codebase search (restricted patterns)
 * 14. analyze: Analysis mode (restricted patterns)
 * 15. codex/gpt: Delegate to Codex MCP (ask_codex)
 * 16. gemini: Delegate to Gemini MCP (ask_gemini)
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(join(__dirname, 'lib', 'stdin.mjs'));

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
    // Fallback: try to extract with regex
    const match = input.match(/"(?:prompt|content|text)"\s*:\s*"([^"]+)"/);
    return match ? match[1] : '';
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
 * Create MCP delegation message (NOT a skill invocation)
 */
function createMcpDelegation(provider, originalPrompt) {
  const configs = {
    codex: {
      tool: 'ask_codex',
      roles: 'architect, planner, critic, analyst, code-reviewer, security-reviewer, tdd-guide',
      defaultRole: 'architect',
    },
    gemini: {
      tool: 'ask_gemini',
      roles: 'designer, writer, vision',
      defaultRole: 'designer',
    },
  };
  const config = configs[provider];
  if (!config) return '';

  return `[MAGIC KEYWORD: ${provider.toUpperCase()}]

You MUST delegate this task to the ${provider === 'codex' ? 'Codex' : 'Gemini'} MCP tool.

Steps:
1. Call ToolSearch("mcp") to discover available MCP tools (required -- they are deferred and not in your tool list by default)
2. Write a prompt file to \`.omc/prompts/${provider}-{purpose}-{timestamp}.md\` containing clear task instructions derived from the user's request
3. Determine the appropriate agent_role from: ${config.roles}
4. Call the \`${config.tool}\` MCP tool with:
   - agent_role: <detected or default "${config.defaultRole}">
   - prompt_file: <path you wrote>
   - output_file: <corresponding -summary.md path>
   - context_files: <relevant files from user's request>

If ToolSearch returns no MCP tools, the MCP server is not configured. Fall back to the equivalent Claude agent instead.

User request:
${originalPrompt}

IMPORTANT: Do NOT invoke a skill. Discover MCP tools via ToolSearch first, then delegate IMMEDIATELY.`;
}

/**
 * Create combined output for skills + MCP delegations
 */
function createCombinedOutput(skillMatches, delegationMatches, originalPrompt) {
  const parts = [];

  if (skillMatches.length > 0) {
    parts.push('## Section 1: Skill Invocations\n\n' + createMultiSkillInvocation(skillMatches, originalPrompt));
  }

  if (delegationMatches.length > 0) {
    const delegationParts = delegationMatches.map(d => createMcpDelegation(d.name, originalPrompt));
    parts.push('## Section ' + (skillMatches.length > 0 ? '2' : '1') + ': MCP Delegations\n\n' + delegationParts.join('\n\n---\n\n'));
  }

  const allNames = [...skillMatches, ...delegationMatches].map(m => m.name.toUpperCase());
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

  // Ecomode beats ultrawork
  if (names.includes('ecomode') && names.includes('ultrawork')) {
    resolved = resolved.filter(m => m.name !== 'ultrawork');
  }

  // Team beats autopilot (legacy ultrapilot semantics)
  if (names.includes('team') && names.includes('autopilot')) {
    resolved = resolved.filter(m => m.name !== 'autopilot');
  }

  // Sort by priority order
  const priorityOrder = ['cancel','ralph','autopilot','team','ultrawork','ecomode',
    'pipeline','ralplan','plan','tdd','research','ultrathink','deepsearch','analyze',
    'codex','gemini'];
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
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      return false;
    }
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    const envValue = settings?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    if (typeof envValue === 'string') {
      const normalized = envValue.toLowerCase().trim();
      return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    return false;
  } catch {
    // Best effort: if we can't read settings, assume disabled
    return false;
  }
}

/**
 * Create a warning message for when team skill is invoked but feature is not enabled
 */
function createTeamWarning() {
  return `⚠️ **TEAM FEATURE NOT ENABLED**

The team skill requires the experimental agent teams feature to be enabled in Claude Code.

To enable teams, add the following to your ~/.claude/settings.json:

\`\`\`json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
\`\`\`

Then restart Claude Code. The team skill will proceed, but may not function correctly without this setting.`;
}

// Main
async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true }));
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
    if (/\b(ralph|don't stop|must complete|until done)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ralph', args: '' });
    }

    // Autopilot keywords
    if (/\b(autopilot|auto pilot|auto-pilot|autonomous|full auto|fullsend)\b/i.test(cleanPrompt) ||
        /\bbuild\s+me\s+/i.test(cleanPrompt) ||
        /\bcreate\s+me\s+/i.test(cleanPrompt) ||
        /\bmake\s+me\s+/i.test(cleanPrompt) ||
        /\bi\s+want\s+a\s+/i.test(cleanPrompt) ||
        /\bi\s+want\s+an\s+/i.test(cleanPrompt) ||
        /\bhandle\s+it\s+all\b/i.test(cleanPrompt) ||
        /\bend\s+to\s+end\b/i.test(cleanPrompt) ||
        /\be2e\s+this\b/i.test(cleanPrompt)) {
      matches.push({ name: 'autopilot', args: '' });
    }

    // Team keywords (including legacy ultrapilot/swarm phrases)
    const swarmMatch = cleanPrompt.match(/\bswarm\s+(\d+)\s+agents?\b/i);
    const hasTeamKeyword = /\b(team)\b/i.test(cleanPrompt) || /\bcoordinated\s+team\b/i.test(cleanPrompt);
    const hasLegacyTeamKeyword = /\b(ultrapilot|ultra-pilot)\b/i.test(cleanPrompt) ||
      /\bparallel\s+build\b/i.test(cleanPrompt) ||
      /\bswarm\s+build\b/i.test(cleanPrompt) ||
      !!swarmMatch ||
      /\bcoordinated\s+agents\b/i.test(cleanPrompt);
    if (hasTeamKeyword || hasLegacyTeamKeyword) {
      matches.push({ name: 'team', args: swarmMatch ? swarmMatch[1] : '' });
    }

    // Ultrawork keywords
    if (/\b(ultrawork|ulw|uw)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrawork', args: '' });
    }

    // Ecomode keywords
    if (/\b(eco|ecomode|eco-mode|efficient|save-tokens|budget)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ecomode', args: '' });
    }

    // Pipeline keywords
    if (/\b(pipeline)\b/i.test(cleanPrompt) || /\bchain\s+agents\b/i.test(cleanPrompt)) {
      matches.push({ name: 'pipeline', args: '' });
    }

    // Ralplan keyword
    if (/\b(ralplan)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ralplan', args: '' });
    }

    // Plan keywords
    if (/\b(plan this|plan the)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'plan', args: '' });
    }

    // TDD keywords
    if (/\b(tdd)\b/i.test(cleanPrompt) ||
        /\btest\s+first\b/i.test(cleanPrompt) ||
        /\bred\s+green\b/i.test(cleanPrompt)) {
      matches.push({ name: 'tdd', args: '' });
    }

    // Research keywords
    if (/\b(research)\b/i.test(cleanPrompt) ||
        /\banalyze\s+data\b/i.test(cleanPrompt) ||
        /\bstatistics\b/i.test(cleanPrompt)) {
      matches.push({ name: 'research', args: '' });
    }

    // Ultrathink keywords
    if (/\b(ultrathink|think hard|think deeply)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrathink', args: '' });
    }

    // Deepsearch keywords
    if (/\b(deepsearch)\b/i.test(cleanPrompt) ||
        /\bsearch\s+(the\s+)?(codebase|code|files?|project)\b/i.test(cleanPrompt) ||
        /\bfind\s+(in\s+)?(codebase|code|all\s+files?)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'deepsearch', args: '' });
    }

    // Analyze keywords
    if (/\b(deep\s*analyze)\b/i.test(cleanPrompt) ||
        /\binvestigate\s+(the|this|why)\b/i.test(cleanPrompt) ||
        /\bdebug\s+(the|this|why)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'analyze', args: '' });
    }

    // Codex keywords (intent-phrase only)
    if (/\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'codex', args: '' });
    }

    // Gemini keywords (intent-phrase only)
    if (/\b(ask|use|delegate\s+to)\s+gemini\b/i.test(cleanPrompt)) {
      matches.push({ name: 'gemini', args: '' });
    }

    // No matches - pass through
    if (matches.length === 0) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Resolve conflicts
    const resolved = resolveConflicts(matches);

    // Handle cancel specially - clear states and emit
    if (resolved.length > 0 && resolved[0].name === 'cancel') {
      clearStateFiles(directory, ['ralph', 'autopilot', 'team', 'ultrawork', 'ecomode', 'pipeline']);
      console.log(JSON.stringify(createHookOutput(createSkillInvocation('cancel', prompt))));
      return;
    }

    // Activate states for modes that need them
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const stateModes = resolved.filter(m => ['ralph', 'autopilot', 'team', 'ultrawork', 'ecomode'].includes(m.name));
    for (const mode of stateModes) {
      activateState(directory, prompt, mode.name, sessionId);
    }

    // Special: Ralph with ultrawork (only if ecomode NOT present)
    const hasRalph = resolved.some(m => m.name === 'ralph');
    const hasEcomode = resolved.some(m => m.name === 'ecomode');
    const hasUltrawork = resolved.some(m => m.name === 'ultrawork');
    if (hasRalph && !hasEcomode && !hasUltrawork) {
      activateState(directory, prompt, 'ultrawork', sessionId);
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

    // Split resolved into skills vs MCP delegations
    const MCP_KEYWORDS = ['codex', 'gemini'];
    const skillMatches = resolved.filter(m => !MCP_KEYWORDS.includes(m.name));
    const delegationMatches = resolved.filter(m => MCP_KEYWORDS.includes(m.name));

    // Check if team skill is being invoked and add warning if feature not enabled
    const hasTeamSkill = skillMatches.some(m => m.name === 'team');
    const teamWarning = hasTeamSkill && !isTeamEnabled() ? createTeamWarning() + '\n\n---\n\n' : '';

    if (skillMatches.length > 0 && delegationMatches.length > 0) {
      // Combined: skills + MCP delegations
      const output = teamWarning + createCombinedOutput(skillMatches, delegationMatches, prompt);
      console.log(JSON.stringify(createHookOutput(output)));
    } else if (delegationMatches.length > 0) {
      // MCP delegation only
      const delegationParts = delegationMatches.map(d => createMcpDelegation(d.name, prompt));
      console.log(JSON.stringify(createHookOutput(delegationParts.join('\n\n---\n\n'))));
    } else {
      // Skills only (existing behavior)
      const output = teamWarning + createMultiSkillInvocation(skillMatches, prompt);
      console.log(JSON.stringify(createHookOutput(output)));
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
