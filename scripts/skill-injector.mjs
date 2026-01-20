#!/usr/bin/env node

/**
 * Skill Injector Hook (UserPromptSubmit)
 * Injects relevant learned skills into context based on prompt triggers.
 *
 * STANDALONE SCRIPT - does not import from dist/
 * Follows pattern of keyword-detector.mjs and session-start.mjs
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Constants
const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'sisyphus-learned');
const PROJECT_SKILLS_SUBDIR = '.omc/skills';
const SKILL_EXTENSION = '.md';
const MAX_SKILLS_PER_SESSION = 5;

// Session cache to avoid re-injecting same skills
const injectedCache = new Map();

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Parse YAML frontmatter from skill file
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlContent = match[1];
  const body = match[2].trim();

  // Simple YAML parsing for triggers
  const triggers = [];
  const triggerMatch = yamlContent.match(/triggers:\s*\n((?:\s+-\s*.+\n?)*)/);
  if (triggerMatch) {
    const lines = triggerMatch[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/);
      if (itemMatch) triggers.push(itemMatch[1].trim().toLowerCase());
    }
  }

  // Extract name
  const nameMatch = yamlContent.match(/name:\s*["']?([^"'\n]+)["']?/);
  const name = nameMatch ? nameMatch[1].trim() : 'Unnamed Skill';

  return { name, triggers, content: body };
}

// Find all skill files
function findSkillFiles(directory) {
  const candidates = [];
  const seenPaths = new Set();

  // Project-level skills (higher priority)
  const projectDir = join(directory, PROJECT_SKILLS_SUBDIR);
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(SKILL_EXTENSION)) {
          const fullPath = join(projectDir, file.name);
          try {
            const realPath = realpathSync(fullPath);
            if (!seenPaths.has(realPath)) {
              seenPaths.add(realPath);
              candidates.push({ path: fullPath, scope: 'project' });
            }
          } catch {
            // Ignore symlink resolution errors
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // User-level skills
  if (existsSync(USER_SKILLS_DIR)) {
    try {
      const files = readdirSync(USER_SKILLS_DIR, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(SKILL_EXTENSION)) {
          const fullPath = join(USER_SKILLS_DIR, file.name);
          try {
            const realPath = realpathSync(fullPath);
            if (!seenPaths.has(realPath)) {
              seenPaths.add(realPath);
              candidates.push({ path: fullPath, scope: 'user' });
            }
          } catch {
            // Ignore symlink resolution errors
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  return candidates;
}

// Find matching skills by trigger keywords
function findMatchingSkills(prompt, directory, sessionId) {
  const promptLower = prompt.toLowerCase();
  const candidates = findSkillFiles(directory);
  const matches = [];

  // Get or create session cache
  if (!injectedCache.has(sessionId)) {
    injectedCache.set(sessionId, new Set());
  }
  const alreadyInjected = injectedCache.get(sessionId);

  for (const candidate of candidates) {
    // Skip if already injected this session
    if (alreadyInjected.has(candidate.path)) continue;

    try {
      const content = readFileSync(candidate.path, 'utf-8');
      const skill = parseSkillFrontmatter(content);
      if (!skill) continue;

      // Check if any trigger matches
      let score = 0;
      for (const trigger of skill.triggers) {
        if (promptLower.includes(trigger)) {
          score += 10;
        }
      }

      if (score > 0) {
        matches.push({
          path: candidate.path,
          name: skill.name,
          content: skill.content,
          score,
          scope: candidate.scope
        });
      }
    } catch {
      // Ignore file read errors
    }
  }

  // Sort by score (descending) and limit
  matches.sort((a, b) => b.score - a.score);
  const selected = matches.slice(0, MAX_SKILLS_PER_SESSION);

  // Mark as injected
  for (const skill of selected) {
    alreadyInjected.add(skill.path);
  }

  return selected;
}

// Format skills for injection
function formatSkillsMessage(skills) {
  const lines = [
    '<mnemosyne>',
    '',
    '## Relevant Learned Skills',
    '',
    'The following skills from previous sessions may help:',
    ''
  ];

  for (const skill of skills) {
    lines.push(`### ${skill.name} (${skill.scope})`);
    lines.push('');
    lines.push(skill.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('</mnemosyne>');
  return lines.join('\n');
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
    try { data = JSON.parse(input); } catch { /* ignore parse errors */ }

    const prompt = data.prompt || '';
    const sessionId = data.sessionId || 'unknown';
    const directory = data.cwd || process.cwd();

    // Skip if no prompt
    if (!prompt) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const matchingSkills = findMatchingSkills(prompt, directory, sessionId);

    if (matchingSkills.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        message: formatSkillsMessage(matchingSkills)
      }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
