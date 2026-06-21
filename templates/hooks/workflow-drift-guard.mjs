#!/usr/bin/env node
/**
 * OMC Workflow Drift Guard Stop hook.
 *
 * Boundary source: https://code.claude.com/docs/en/hooks documents Stop
 * hooks with last_assistant_message and decision:"block";
 * https://code.claude.com/docs/en/plugins-reference documents plugin
 * hooks/hooks.json loading and the shared lifecycle events.
 * This guard uses only deterministic Stop-hook signals and intentionally
 * fails open for ambiguous/free-form cases.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
const { readStdin } = await import(new URL('./lib/stdin.mjs', import.meta.url));

const HOOK_NAME = 'workflow-drift-guard';
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.sh', '.bash', '.zsh', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp']);
const COMPLETION_CLAIM_RE = /\b(?:done|complete[sd]?|finished|implemented|fixed|resolved|all set|ready\s+(?:for\s+(?:review|merge|release|qa|testing)|to\s+(?:merge|ship|release|submit)))\b/i;
const QUESTION_END_RE = /\?\s*(?:[\])}"'`]*\s*)?$/;
const STRUCTURED_CHOICE_RE = /\b(?:should i|would you like me to|do you want me to|which (?:option|approach|path)|choose|pick|select|approve|proceed)\b/i;
const FREE_FORM_RE = /\b(?:free[- ]?form|other|provide(?: me)? (?:the )?exact|what exact|paste|send me|enter|type|tell me|describe|explain)\b/i;
const BLOCKER_PATTERNS = [
  { kind: 'skipped test', pattern: /\b(?:it|test|describe)\.skip\s*\(/i },
  { kind: 'focused test', pattern: /\b(?:it|test|describe)\.only\s*\(/i },
  { kind: 'placeholder TODO', pattern: /\bTODO\b(?:\([^)]*\))?\s*:?\s*(?:implement|fix|replace|stub|placeholder|later|follow[- ]?up|wire|add\b|fill)/i },
  { kind: 'unimplemented throw', pattern: /throw\s+new\s+Error\s*\(\s*["'`](?:TODO|Not implemented|unimplemented|stub)/i },
  { kind: 'placeholder return', pattern: /\breturn\s+(?:null|undefined)\s*;?\s*\/\/\s*(?:TODO|stub|placeholder|not implemented)/i },
  { kind: 'placeholder implementation', pattern: /\b(?:stub|placeholder|not implemented|unimplemented)\s+(?:implementation|branch|path|test|coverage)\b/i },
];

function skippedByEnv() {
  if (process.env.DISABLE_OMC === '1' || process.env.DISABLE_OMC === 'true') return true;
  return (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim()).includes(HOOK_NAME);
}

function safeJsonParse(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function lastAssistantMessage(input) {
  for (const key of ['last_assistant_message', 'lastAssistantMessage', 'message', 'output', 'response', 'text']) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isCodePath(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch { return ''; }
}

function changedCodePaths(cwd) {
  const names = new Set();
  for (const line of git(cwd, ['diff', '--name-only', 'HEAD', '--']).split('\n')) {
    const path = line.trim();
    if (path && isCodePath(path)) names.add(path);
  }
  for (const line of git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const path = line.trim();
    if (path && isCodePath(path)) names.add(path);
  }
  return [...names];
}

function addedLinesForPath(cwd, path) {
  const diff = git(cwd, ['diff', '--unified=0', 'HEAD', '--', path]);
  if (diff) {
    const added = [];
    let newLine = 0;
    for (const line of diff.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number.parseInt(hunk[1], 10);
        continue;
      }
      if (line.startsWith('+++') || line.startsWith('---') || newLine === 0) continue;
      if (line.startsWith('+')) {
        added.push({ lineNumber: newLine, text: line.slice(1) });
        newLine += 1;
      } else if (!line.startsWith('-')) {
        newLine += 1;
      }
    }
    return added;
  }
  const fullPath = join(cwd, path);
  if (!existsSync(fullPath)) return [];
  try {
    return readFileSync(fullPath, 'utf8')
      .split('\n')
      .map((text, index) => ({ lineNumber: index + 1, text }));
  } catch { return []; }
}

function stripQuotedAndRegexLiterals(line) {
  let result = '';
  let quote = '';
  let escaped = false;
  let inRegex = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const prev = line[index - 1] || '';
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      result += ' ';
      continue;
    }
    if (inRegex) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '/') {
        inRegex = false;
      }
      result += ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      result += ' ';
      continue;
    }
    if (char === '/' && prev !== '/' && prev !== '*' && /[=(:,\[]/.test(prev.trim() || '=')) {
      inRegex = true;
      result += ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function blockerScanText(text) {
  const stripped = stripQuotedAndRegexLiterals(text);
  const commentIndex = stripped.indexOf('//');
  if (commentIndex >= 0) return stripped.slice(commentIndex);
  return stripped;
}

function findCompletionBlockers(cwd) {
  const blockers = [];
  for (const path of changedCodePaths(cwd)) {
    const lines = addedLinesForPath(cwd, path);
    lines.forEach(({ lineNumber, text }) => {
      const scanText = blockerScanText(text);
      for (const { kind, pattern } of BLOCKER_PATTERNS) {
        if (pattern.test(scanText)) {
          blockers.push({ path, line: lineNumber, kind, text: text.trim().slice(0, 160) });
          break;
        }
      }
    });
  }
  return blockers.slice(0, 8);
}

function shouldBlockProseQuestion(message) {
  if (!QUESTION_END_RE.test(message)) return false;
  if (!STRUCTURED_CHOICE_RE.test(message)) return false;
  if (FREE_FORM_RE.test(message)) return false;
  return true;
}

function makeBlock(reason) {
  return { decision: 'block', reason };
}

async function main() {
  if (skippedByEnv()) {
    console.log(JSON.stringify({ suppressOutput: true }));
    return;
  }
  const input = safeJsonParse(await readStdin());
  // Claude Code docs warn Stop hooks receive stop_hook_active while already
  // continuing from a Stop hook; fail open to avoid self-reinforcing loops.
  if (input.stop_hook_active === true || input.stopHookActive === true) {
    console.log(JSON.stringify({ suppressOutput: true }));
    return;
  }

  const message = lastAssistantMessage(input);
  if (shouldBlockProseQuestion(message)) {
    console.log(JSON.stringify(makeBlock('[WORKFLOW DRIFT GUARD] The final response ends with a preference/approval question that should be asked with structured AskUserQuestion. Continue by calling AskUserQuestion with 2-4 options and keep allowOther enabled unless free-form input is unsafe.')));
    return;
  }

  const cwd = typeof input.cwd === 'string' ? input.cwd : (typeof input.directory === 'string' ? input.directory : process.cwd());
  if (message && COMPLETION_CLAIM_RE.test(message)) {
    const blockers = findCompletionBlockers(cwd);
    if (blockers.length > 0) {
      const details = blockers.map(b => `${b.path}:${b.line} ${b.kind} — ${b.text}`).join('\n');
      console.log(JSON.stringify(makeBlock(`[WORKFLOW DRIFT GUARD] Completion was claimed while changed code still contains TODO/stub/skipped-test blockers. Resolve them or explicitly report the blocker instead of claiming completion.\n${details}`)));
      return;
    }
  }

  console.log(JSON.stringify({ suppressOutput: true }));
}

main().catch((error) => {
  console.error(`[workflow-drift-guard] ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ suppressOutput: true }));
});
