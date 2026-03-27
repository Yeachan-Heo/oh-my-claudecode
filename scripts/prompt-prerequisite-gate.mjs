#!/usr/bin/env node

import { readStdin } from './lib/stdin.mjs';

const PREREQUISITE_SECTION_REGEX =
  /^#\s*(MÉMOIRE|MEMOIRE|SKILLS|VERIFY-FIRST|CONTEXT|PREREQUISITE|VERIFY|CHECK-FIRST)\b.*$/gim;

const TOOL_LINE_REGEX =
  /(supermemory\s+search\s+(?:"[^"]+"|'[^']+'|\S+)|\b(?:notepad_read|project_memory_read|state_read|state_list_active|state_get_status|Read|Grep|Glob|Edit|Write|Bash|TodoWrite|todowrite|lsp_[a-z_]+|context7_[a-z0-9_-]+|skill_mcp|webfetch)\b)/i;

const TOOL_TOKEN_REGEX =
  /\b(supermemory\s+search\s+(?:"[^"]+"|'[^']+'|\S+)|notepad_read|project_memory_read|state_read|state_list_active|state_get_status|Read|Grep|Glob|Edit|Write|Bash|TodoWrite|todowrite|lsp_[a-z_]+|context7_[a-z0-9_-]+|skill_mcp|webfetch)\b/gi;

function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (typeof data.prompt === 'string') return data.prompt;
    if (typeof data.message?.content === 'string') return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ');
    }
    return '';
  } catch {
    return '';
  }
}

function unique(items) {
  const seen = new Set();
  const ordered = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      ordered.push(item);
    }
  }
  return ordered;
}

function normalizeLine(line) {
  return line
    .replace(/^\s*[-*]\s*/, '')
    .replace(/`/g, '')
    .trim();
}

function getPrerequisiteSections(prompt) {
  const sections = [];
  const matches = [...prompt.matchAll(PREREQUISITE_SECTION_REGEX)];

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? prompt.length;
    sections.push({
      heading: current[1],
      body: prompt.slice(start, end).trim()
    });
  }

  return sections;
}

function extractToolCalls(sections) {
  const fromLines = [];
  const fromTokens = [];

  for (const section of sections) {
    const lines = section.body.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = normalizeLine(rawLine);
      if (!line) continue;

      if (TOOL_LINE_REGEX.test(line)) {
        fromLines.push(line);
      }

      const tokenMatches = line.match(TOOL_TOKEN_REGEX) || [];
      for (const token of tokenMatches) {
        fromTokens.push(token.trim());
      }
    }
  }

  const combined = unique([...fromLines, ...fromTokens]);
  if (combined.length > 0) return combined;

  return ['No explicit tool calls extracted. Follow all prerequisite section instructions before implementation.'];
}

function buildReminder(toolCalls) {
  const calls = toolCalls.map((call) => '- ' + call).join('\n');
  return [
    '<system-reminder>',
    "BLOCKING PREREQUISITE: The user's prompt contains prerequisite sections that MUST be executed BEFORE any Edit/Write/Agent/Task call:",
    '',
    calls,
    '',
    'Execute ALL prerequisite tool calls FIRST. Only proceed with implementation after all prerequisites are complete.',
    '</system-reminder>'
  ].join('\n');
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const prerequisiteSections = getPrerequisiteSections(prompt);
    if (prerequisiteSections.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const toolCalls = extractToolCalls(prerequisiteSections);
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: buildReminder(toolCalls)
      }
    }));
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
