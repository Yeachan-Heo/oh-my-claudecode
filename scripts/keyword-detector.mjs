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
 * 4. ultrapilot: Parallel autopilot
 * 5. ultrawork/ulw: Maximum parallel execution
 * 6. ecomode/eco: Token-efficient execution
 * 7. swarm: N coordinated agents
 * 8. pipeline: Sequential agent chaining
 * 9. ralplan: Iterative planning with consensus
 * 10. plan: Planning interview mode
 * 11. tdd: Test-driven development
 * 12. research: Research orchestration
 * 13. ultrathink/think: Extended reasoning
 * 14. deepsearch: Codebase search (restricted patterns)
 * 15. analyze: Analysis mode (restricted patterns)
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

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
    // 4. Strip file paths: /foo/bar/baz or foo/bar/baz (using lookbehind to avoid consuming leading char)
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
  try { writeFileSync(join(localDir, `${stateName}-state.json`), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}

  // Write to global .omc/state directory
  const globalDir = join(homedir(), '.omc', 'state');
  if (!existsSync(globalDir)) {
    try { mkdirSync(globalDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(globalDir, `${stateName}-state.json`), JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}
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

  // Ultrapilot beats autopilot
  if (names.includes('ultrapilot') && names.includes('autopilot')) {
    resolved = resolved.filter(m => m.name !== 'autopilot');
  }

  // Sort by priority order
  const priorityOrder = ['cancel','ralph','autopilot','ultrapilot','ultrawork','ecomode',
    'swarm','pipeline','ralplan','plan','tdd','research','ultrathink','deepsearch','analyze'];
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
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || '';

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

    // Ultrapilot keywords
    if (/\b(ultrapilot|ultra-pilot)\b/i.test(cleanPrompt) ||
        /\bparallel\s+build\b/i.test(cleanPrompt) ||
        /\bswarm\s+build\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrapilot', args: '' });
    }

    // Ultrawork keywords
    if (/\b(ultrawork|ulw|uw)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ultrawork', args: '' });
    }

    // Ecomode keywords
    if (/\b(eco|ecomode|eco-mode|efficient|save-tokens|budget)\b/i.test(cleanPrompt)) {
      matches.push({ name: 'ecomode', args: '' });
    }

    // Swarm - parse N from "swarm N agents"
    const swarmMatch = cleanPrompt.match(/\bswarm\s+(\d+)\s+agents?\b/i);
    if (swarmMatch || /\bcoordinated\s+agents\b/i.test(cleanPrompt)) {
      const agentCount = swarmMatch ? swarmMatch[1] : '3';
      matches.push({ name: 'swarm', args: agentCount });
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

    // No matches - pass through
    if (matches.length === 0) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Resolve conflicts
    const resolved = resolveConflicts(matches);

    // Handle cancel specially - clear states and emit
    if (resolved.length > 0 && resolved[0].name === 'cancel') {
      clearStateFiles(directory, ['ralph', 'autopilot', 'ultrapilot', 'ultrawork', 'ecomode', 'swarm', 'pipeline']);
      console.log(JSON.stringify(createHookOutput(createSkillInvocation('cancel', prompt))));
      return;
    }

    // Activate states for modes that need them
    const stateModes = resolved.filter(m => ['ralph', 'autopilot', 'ultrapilot', 'ultrawork', 'ecomode'].includes(m.name));
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

    // Emit skill invocation(s)
    console.log(JSON.stringify(createHookOutput(createMultiSkillInvocation(resolved, prompt))));
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
