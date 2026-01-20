#!/usr/bin/env node

/**
 * Sisyphus Keyword Detector Hook (Node.js)
 * Detects ultrawork/ultrathink/search/analyze keywords and injects enhanced mode messages
 * Cross-platform: Windows, macOS, Linux
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ULTRAWORK_MESSAGE = `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

[CODE RED] Maximum precision required. Ultrathink before acting.

YOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.
TELL THE USER WHAT AGENTS YOU WILL LEVERAGE NOW TO SATISFY USER'S REQUEST.

## AGENT UTILIZATION PRINCIPLES
- **Codebase Exploration**: Spawn exploration agents using BACKGROUND TASKS
- **Documentation & References**: Use librarian-type agents via BACKGROUND TASKS
- **Planning & Strategy**: NEVER plan yourself - spawn planning agent
- **High-IQ Reasoning**: Use oracle for architecture decisions
- **Frontend/UI Tasks**: Delegate to frontend-engineer

## EXECUTION RULES
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY.
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially.
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent).
- **VERIFY**: Check ALL requirements met before done.
- **DELEGATE**: Orchestrate specialized agents.

## ZERO TOLERANCE
- NO Scope Reduction - deliver FULL implementation
- NO Partial Completion - finish 100%
- NO Premature Stopping - ALL TODOs must be complete
- NO TEST DELETION - fix code, not tests

THE USER ASKED FOR X. DELIVER EXACTLY X.

</ultrawork-mode>

---
`;

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
- librarian agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, Glob
NEVER stop at first result - be exhaustive.
</search-mode>

---
`;

const ANALYZE_MESSAGE = `<analyze-mode>
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 librarian agents (if external library involved)
- Direct tools: Grep, Glob, LSP for targeted searches

IF COMPLEX (architecture, multi-system, debugging after 2+ failures):
- Consult oracle agent for strategic guidance

SYNTHESIZE findings before proceeding.
</analyze-mode>

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

// Remove code blocks to prevent false positives
function removeCodeBlocks(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '');
}

// Create ultrawork state file
function activateUltraworkState(directory, prompt) {
  const state = {
    active: true,
    started_at: new Date().toISOString(),
    original_prompt: prompt,
    reinforcement_count: 0,
    last_checked_at: new Date().toISOString()
  };

  // Write to local .sisyphus directory
  const localDir = join(directory, '.omc');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(localDir, 'ultrawork-state.json'), JSON.stringify(state, null, 2)); } catch {}

  // Write to global .claude directory
  const globalDir = join(homedir(), '.claude');
  if (!existsSync(globalDir)) {
    try { mkdirSync(globalDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(globalDir, 'ultrawork-state.json'), JSON.stringify(state, null, 2)); } catch {}
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

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const cleanPrompt = removeCodeBlocks(prompt).toLowerCase();

    // Check for ultrawork keywords (highest priority)
    if (/\b(ultrawork|ulw|uw)\b/.test(cleanPrompt)) {
      activateUltraworkState(directory, prompt);
      console.log(JSON.stringify({ continue: true, message: ULTRAWORK_MESSAGE }));
      return;
    }

    // Check for ultrathink/think keywords
    if (/\b(ultrathink|think)\b/.test(cleanPrompt)) {
      console.log(JSON.stringify({ continue: true, message: ULTRATHINK_MESSAGE }));
      return;
    }

    // Check for search keywords
    if (/\b(search|find|locate|lookup|explore|discover|scan|grep|query|browse|detect|trace|seek|track|pinpoint|hunt)\b|where\s+is|show\s+me|list\s+all/.test(cleanPrompt)) {
      console.log(JSON.stringify({ continue: true, message: SEARCH_MESSAGE }));
      return;
    }

    // Check for analyze keywords
    if (/\b(analyze|analyse|investigate|examine|research|study|deep.?dive|inspect|audit|evaluate|assess|review|diagnose|scrutinize|dissect|debug|comprehend|interpret|breakdown|understand)\b|why\s+is|how\s+does|how\s+to/.test(cleanPrompt)) {
      console.log(JSON.stringify({ continue: true, message: ANALYZE_MESSAGE }));
      return;
    }

    // No keywords detected
    console.log(JSON.stringify({ continue: true }));
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
