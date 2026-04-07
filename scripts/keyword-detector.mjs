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
 * 4. team: Explicit-only via /team (not auto-triggered)
 * 5. ultrawork/ulw: Maximum parallel execution
 * 5. ccg: Claude-Codex-Gemini tri-model orchestration
 * 6. ralplan: Iterative planning with consensus
 * 7. deep interview: Socratic interview workflow
 * 8. ai-slop-cleaner: Cleanup/deslop anti-slop workflow
 * 9. tdd: Test-driven development
 * 10. code review: Comprehensive review mode
 * 11. security review: Security-focused review mode
 * 12. ultrathink: Extended reasoning
 * 13. deepsearch: Codebase search (restricted patterns)
 * 14. analyze: Analysis mode (restricted patterns)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { readStdin } from './lib/stdin.mjs';

// Resolve OMC package root: CLAUDE_PLUGIN_ROOT (plugin system) or derive from this script's location
const _omcRoot = process.env.CLAUDE_PLUGIN_ROOT ||
  join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load skill content directly from SKILL.md on disk.
 * Works for both npm installs and plugin marketplace installs.
 * Returns null if the skill file is not found.
 */
function loadSkillContent(skillName) {
  const skillPath = join(_omcRoot, 'skills', skillName, 'SKILL.md');
  if (existsSync(skillPath)) {
    try { return readFileSync(skillPath, 'utf8'); } catch { /* fall through */ }
  }
  return null;
}

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

const SEARCH_MESSAGE = `<search-mode>
MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
- explore agents (codebase patterns, file structures)
- document-specialist agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, Glob
NEVER stop at first result - be exhaustive.
</search-mode>

---
`;

const ANALYZE_MESSAGE = `<analyze-mode>
ANALYSIS MODE. Gather context before diving deep:
- Search relevant code paths first
- Compare working vs broken behavior
- Synthesize findings before proposing changes
</analyze-mode>

---
`;

const TDD_MESSAGE = `<tdd-mode>
[TDD MODE ACTIVATED]
Write or update tests first when practical, confirm they fail for the right reason, then implement the minimal fix and re-run verification.
</tdd-mode>

---
`;

const CODE_REVIEW_MESSAGE = `<code-review-mode>
[CODE REVIEW MODE ACTIVATED]
Perform a comprehensive code review of the relevant changes or target area. Focus on correctness, maintainability, edge cases, regressions, and test adequacy before recommending changes.
</code-review-mode>

---
`;

const SECURITY_REVIEW_MESSAGE = `<security-review-mode>
[SECURITY REVIEW MODE ACTIVATED]
Perform a focused security review of the relevant changes or target area. Check trust boundaries, auth/authz, data exposure, input validation, command/file access, secrets handling, and escalation risks before recommending changes.
</security-review-mode>

---
`;

const MODE_MESSAGE_KEYWORDS = new Map([
  ['ultrathink', ULTRATHINK_MESSAGE],
  ['deepsearch', SEARCH_MESSAGE],
  ['analyze', ANALYZE_MESSAGE],
  ['tdd', TDD_MESSAGE],
  ['code-review', CODE_REVIEW_MESSAGE],
  ['security-review', SECURITY_REVIEW_MESSAGE],
]);

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
const ANTI_SLOP_EXPLICIT_PATTERN = /\b(ai[\s-]?slop|anti[\s-]?slop|deslop|de[\s-]?slop)\b/i;
const ANTI_SLOP_ACTION_PATTERN = /\b(clean(?:\s*up)?|cleanup|refactor|simplify|dedupe|de-duplicate|prune)\b/i;
const ANTI_SLOP_SMELL_PATTERN = /\b(slop|duplicate(?:d|s)?|duplication|dead\s+code|unused\s+code|over[\s-]?abstract(?:ion|ed)?|wrapper\s+layers?|boundary\s+violations?|needless\s+abstractions?|unnecessary\s+abstractions?|ai[\s-]?generated|generated\s+code|tech\s+debt)\b/i;

function isAntiSlopCleanupRequest(text) {
  return ANTI_SLOP_EXPLICIT_PATTERN.test(text) ||
    (ANTI_SLOP_ACTION_PATTERN.test(text) && ANTI_SLOP_SMELL_PATTERN.test(text));
}

function sanitizeForKeywordDetection(text) {
  return text
    // 0. Strip HTML/markdown comments before tag stripping
    .replace(/<!--[\s\S]*?-->/g, '')
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

const INFORMATIONAL_INTENT_PATTERNS = [
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
  /(?:뭐야|뭔데|무엇(?:이야|인가요)?|어떻게|설명(?!서)|사용법|알려\s?줘|알려줄래|소개해?\s?줘|소개\s*부탁|설명해\s?줘|뭐가\s*달라|어떤\s*기능|기능\s*(?:알려|설명|뭐)|방법\s*(?:알려|설명|뭐))/u,
  /(?:とは|って何|使い方|説明)/u,
  /(?:什么是|什麼是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
];
const INFORMATIONAL_CONTEXT_WINDOW = 80;

function isInformationalKeywordContext(text, position, keywordLength) {
  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  return INFORMATIONAL_INTENT_PATTERNS.some((pattern) => pattern.test(context));
}

function hasActionableKeyword(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    if (isInformationalKeywordContext(text, match.index, match[0].length)) {
      continue;
    }

    return true;
  }

  return false;
}

// Create state file for a mode
function activateState(directory, prompt, stateName, sessionId) {
  let state;

  if (stateName === 'ralph') {
    // Ralph needs specific fields for proper loop tracking
    state = {
      active: true,
      iteration: 1,
      max_iterations: 100,
      started_at: new Date().toISOString(),
      prompt: prompt,
      session_id: sessionId || undefined,
      project_path: directory,
      linked_ultrawork: true,
      awaiting_confirmation: true,
      last_checked_at: new Date().toISOString()
    };
  } else if (stateName === 'ralplan') {
    // Ralplan needs active + session_id for stop-hook enforcement
    state = {
      active: true,
      started_at: new Date().toISOString(),
      session_id: sessionId || undefined,
      project_path: directory,
      awaiting_confirmation: true,
      last_checked_at: new Date().toISOString()
    };
  } else {
    // Generic state for ultrawork, autopilot, etc.
    state = {
      active: true,
      started_at: new Date().toISOString(),
      original_prompt: prompt,
      session_id: sessionId || undefined,
      project_path: directory,
      reinforcement_count: 0,
      awaiting_confirmation: true,
      last_checked_at: new Date().toISOString()
    };
  }

  // Write to session-scoped path if sessionId available
  if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    const sessionDir = join(directory, '.omc', 'state', 'sessions', sessionId);
    if (!existsSync(sessionDir)) {
      try { mkdirSync(sessionDir, { recursive: true }); } catch {}
    }
    try { writeFileSync(join(sessionDir, `${stateName}-state.json`), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}
    return;
  }

  // Fallback: write to legacy local .omc/state directory
  const localDir = join(directory, '.omc', 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(localDir, `${stateName}-state.json`), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}
}

/**
 * Clear state files for cancel operation
 */
function clearStateFiles(directory, modeNames, sessionId) {
  for (const name of modeNames) {
    const localPath = join(directory, '.omc', 'state', `${name}-state.json`);
    const globalPath = join(homedir(), '.omc', 'state', `${name}-state.json`);
    try { if (existsSync(localPath)) unlinkSync(localPath); } catch {}
    try { if (existsSync(globalPath)) unlinkSync(globalPath); } catch {}
    // Clear session-scoped file too
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      const sessionPath = join(directory, '.omc', 'state', 'sessions', sessionId, `${name}-state.json`);
      try { if (existsSync(sessionPath)) unlinkSync(sessionPath); } catch {}
    }
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
 * Check if the team feature is enabled in Claude Code settings.
 * Reads settings.json from [$CLAUDE_CONFIG_DIR|~/.claude] and checks for
 * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var.
 * @returns {boolean} true if team feature is enabled
 */
function isTeamEnabled() {
  try {
    // Check settings.json first (authoritative, user-controlled)
    const cfgDir = getClaudeConfigDir();
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
  } catch {
    return false;
  }
}

/**
 * Create a skill invocation message.
 * Prefers direct SKILL.md content injection (works for npm and plugin installs).
 * Falls back to Skill tool invocation (requires plugin marketplace install).
 */
function createSkillInvocation(skillName, originalPrompt, args = '') {
  const argsSection = args ? `\nArguments: ${args}` : '';
  const skillContent = loadSkillContent(skillName);
  if (skillContent) {
    return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]\n\n${skillContent}\n\n---\nUser request:\n${originalPrompt}${argsSection}`;
  }
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
    const content = loadSkillContent(s.name);
    if (content) {
      return `### Skill ${i + 1}: ${s.name.toUpperCase()}\n\n${content}${argsSection}`;
    }
    return `### Skill ${i + 1}: ${s.name.toUpperCase()}\nSkill: oh-my-claudecode:${s.name}${argsSection}`;
  }).join('\n\n');

  const hasDirectContent = skills.some(s => loadSkillContent(s.name));
  return `[MAGIC KEYWORDS DETECTED: ${skills.map(s => s.name.toUpperCase()).join(', ')}]

${hasDirectContent ? 'Execute ALL of the following skills in order:' : 'You MUST invoke ALL of the following skills using the Skill tool, in order:'}

${skillBlocks}

User request:
${originalPrompt}

IMPORTANT: Complete ALL skills listed above in order. Start with the first skill IMMEDIATELY.`;
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


  // Team keyword detection removed — team is now explicit-only via /team skill.

  // Sort by priority order
  const priorityOrder = ['cancel','ralph','autopilot','ultrawork',
    'ccg','ralplan','deep-interview','ai-slop-cleaner','tdd','code-review','security-review','ultrathink','deepsearch','analyze'];
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

// Main
async function main() {
  // Skip guard: check OMC_SKIP_HOOKS env var (see issue #838)
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || _skipHooks.includes('keyword-detector')) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Team worker guard: prevent keyword detection inside team workers to avoid
  // infinite spawning loops (worker detects "team" -> invokes team skill -> spawns more workers)
  if (process.env.OMC_TEAM_WORKER) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const cleanPrompt = sanitizeForKeywordDetection(prompt).toLowerCase();

    // Collect all matching keywords
    const matches = [];

    // Cancel keywords
    if (hasActionableKeyword(cleanPrompt, /\b(cancelomc|stopomc)\b/i)) {
      matches.push({ name: 'cancel', args: '' });
    }

    // Ralph keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ralph|don't stop|must complete|until done)\b|(랄프)(?!로렌)/i)) {
      matches.push({ name: 'ralph', args: '' });
    }

    // Autopilot keywords
    if (hasActionableKeyword(cleanPrompt, /\b(autopilot|auto pilot|auto-pilot|autonomous|full auto|fullsend)\b|(오토파일럿)/i) ||
        hasActionableKeyword(cleanPrompt, /\b(build|create|make)\s+me\s+(an?\s+)?(app|feature|project|tool|plugin|website|api|server|cli|script|system|service|dashboard|bot|extension)\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bi\s+want\s+a\s+/i) ||
        hasActionableKeyword(cleanPrompt, /\bi\s+want\s+an\s+/i) ||
        hasActionableKeyword(cleanPrompt, /\bhandle\s+it\s+all\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bend\s+to\s+end\b/i) ||
        hasActionableKeyword(cleanPrompt, /\be2e\s+this\b/i)) {
      matches.push({ name: 'autopilot', args: '' });
    }

    // Ultrapilot keywords removed — routed to team which is now explicit-only (/team).

    // Ultrawork keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ultrawork|ulw|uw)\b|(울트라워크)/i)) {
      matches.push({ name: 'ultrawork', args: '' });
    }


    // Team keyword detection removed — team mode is now explicit-only via /team skill.
    // This prevents infinite spawning when Claude workers receive prompts containing "team".


    // CCG keywords (Claude-Codex-Gemini tri-model orchestration)
    if (hasActionableKeyword(cleanPrompt, /\b(ccg|claude-codex-gemini)\b|(씨씨지)/i)) {
      matches.push({ name: 'ccg', args: '' });
    }

    // Ralplan keyword
    if (hasActionableKeyword(cleanPrompt, /\b(ralplan)\b|(랄플랜)/i)) {
      matches.push({ name: 'ralplan', args: '' });
    }

    // Deep interview keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)/i)) {
      matches.push({ name: 'deep-interview', args: '' });
    }

    // AI slop cleanup keywords
    if (isAntiSlopCleanupRequest(cleanPrompt)) {
      matches.push({ name: 'ai-slop-cleaner', args: '' });
    }

    // TDD keywords
    if (hasActionableKeyword(cleanPrompt, /\b(tdd)\b|(테스트\s?퍼스트)/i) ||
        hasActionableKeyword(cleanPrompt, /\btest\s+first\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bred\s+green\b/i)) {
      matches.push({ name: 'tdd', args: '' });
    }

    // Code review keywords
    if (hasActionableKeyword(cleanPrompt, /\b(code\s+review|review\s+code)\b|(코드\s?리뷰)(?!어)/i)) {
      matches.push({ name: 'code-review', args: '' });
    }

    // Security review keywords
    if (hasActionableKeyword(cleanPrompt, /\b(security\s+review|review\s+security)\b|(보안\s?리뷰)(?!어)/i)) {
      matches.push({ name: 'security-review', args: '' });
    }

    // Ultrathink keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ultrathink|think hard|think deeply)\b|(울트라씽크)/i)) {
      matches.push({ name: 'ultrathink', args: '' });
    }

    // Deepsearch keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deepsearch)\b|(딥\s?서치)/i) ||
        hasActionableKeyword(cleanPrompt, /\bsearch\s+(the\s+)?(codebase|code|files?|project)\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bfind\s+(in\s+)?(codebase|code|all\s+files?)\b/i)) {
      matches.push({ name: 'deepsearch', args: '' });
    }

    // Analyze keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deep[\s-]?analyze|deepanalyze)\b|(딥\s?분석)/i)) {
      matches.push({ name: 'analyze', args: '' });
    }

    // Wiki keywords
    if (hasActionableKeyword(cleanPrompt, /\b(wiki(?:\s+(?:this|add|lint|query))?)\b/i)) {
      matches.push({ name: 'wiki', args: '' });
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

    // Import flow tracer once (best-effort)
    let tracer = null;
    try { tracer = await import('../dist/hooks/subagent-tracker/flow-tracer.js'); } catch { /* silent */ }

    // Import follow-up planner modules (best-effort — requires npm run build)
    let followupPlanner = null;
    let planningArtifacts = null;
    try {
      followupPlanner = await import('../dist/team/followup-planner.js');
      planningArtifacts = await import('../dist/planning/artifacts.js');
    } catch { /* silent — dist/ may not exist yet */ }

    // Check for approved follow-up shortcut: bypass ralplan gate when a prior ralplan
    // cycle completed and left an approved plan with a launch hint.
    if (followupPlanner && planningArtifacts) {
      // Detect if ralplan state exists (was recently active) — serves as "prior skill = ralplan" signal
      const ralplanStatePath = sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)
        ? join(directory, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json')
        : join(directory, '.omc', 'state', 'ralplan-state.json');
      const ralplanWasActive = existsSync(ralplanStatePath);

      if (ralplanWasActive) {
        const artifacts = planningArtifacts.readPlanningArtifacts(directory);
        const planningComplete = planningArtifacts.isPlanningComplete(artifacts);
        const context = { planningComplete, priorSkill: 'ralplan' };

        const isTeamFollowup = followupPlanner.isApprovedExecutionFollowupShortcut('team', prompt, context);
        const isRalphFollowup = followupPlanner.isApprovedExecutionFollowupShortcut('ralph', prompt, context);

        if (isTeamFollowup) {
          console.log(JSON.stringify(createHookOutput(createSkillInvocation('team', prompt))));
          return;
        }
        if (isRalphFollowup) {
          console.log(JSON.stringify(createHookOutput(createSkillInvocation('ralph', prompt))));
          return;
        }
      }
    }

    // Record detected keywords to flow trace
    if (tracer) {
      for (const match of resolved) {
        try { tracer.recordKeywordDetected(directory, sessionId, match.name); } catch { /* silent */ }
      }
    }

    // Handle cancel specially - clear states and emit
    if (resolved.length > 0 && resolved[0].name === 'cancel') {
      clearStateFiles(directory, ['ralph', 'autopilot', 'ultrawork', 'swarm', 'ralplan'], sessionId);
      console.log(JSON.stringify(createHookOutput(createSkillInvocation('cancel', prompt))));
      return;
    }

    // Activate states for modes that need them (team removed — explicit-only via /team skill)
    const stateModes = resolved.filter(m => ['ralph', 'autopilot', 'ultrawork', 'ralplan'].includes(m.name));
    for (const mode of stateModes) {
      activateState(directory, prompt, mode.name, sessionId);
    }

    // Record mode changes to flow trace
    if (tracer) {
      for (const mode of stateModes) {
        try { tracer.recordModeChange(directory, sessionId, 'none', mode.name); } catch { /* silent */ }
      }
    }

    // Special: Ralph with ultrawork
    const hasRalph = resolved.some(m => m.name === 'ralph');
    const hasUltrawork = resolved.some(m => m.name === 'ultrawork');
    if (hasRalph && !hasUltrawork) {
      activateState(directory, prompt, 'ultrawork', sessionId);
    }

    const additionalContextParts = [];
    for (const [keywordName, message] of MODE_MESSAGE_KEYWORDS) {
      const index = resolved.findIndex(m => m.name === keywordName);
      if (index !== -1) {
        resolved.splice(index, 1);
        additionalContextParts.push(message);
      }
    }

    if (resolved.length === 0 && additionalContextParts.length > 0) {
      console.log(JSON.stringify(createHookOutput(additionalContextParts.join(''))));
      return;
    }

    if (resolved.length > 0) {
      additionalContextParts.push(createMultiSkillInvocation(resolved, prompt));
    }

    if (additionalContextParts.length > 0) {
      console.log(JSON.stringify(createHookOutput(additionalContextParts.join(''))));
      return;
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
