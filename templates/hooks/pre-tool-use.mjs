#!/usr/bin/env node
/**
 * OMC Pre-Tool-Use Hook (Node.js)
 * Enforces delegation by warning when orchestrator attempts direct source file edits
 */

import * as path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(path.join(__dirname, 'lib', 'stdin.mjs'));

// Allowed path patterns (no warning)
const ALLOWED_PATH_PATTERNS = [
  /\.omc\//,
  /\.claude\//,
  /\/\.claude\//,
  /CLAUDE\.md$/,
  /AGENTS\.md$/,
];

// Source file extensions (should warn)
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php',
  '.svelte', '.vue',
  '.graphql', '.gql',
  '.sh', '.bash', '.zsh',
]);

function isAllowedPath(filePath) {
  if (!filePath) return true;
  return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(filePath));
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

// Patterns that indicate file modification in bash commands
const FILE_MODIFY_PATTERNS = [
  /sed\s+-i/,
  />\s*[^&]/,
  />>/,
  /tee\s+/,
  /cat\s+.*>\s*/,
  /echo\s+.*>\s*/,
  /printf\s+.*>\s*/,
];

// Source file pattern for command inspection
const SOURCE_EXT_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|rs|java|kt|scala|c|cpp|cc|h|hpp|rb|php|svelte|vue|graphql|gql|sh|bash|zsh)/i;

function checkBashCommand(command) {
  // Check if command might modify files
  const mayModify = FILE_MODIFY_PATTERNS.some(pattern => pattern.test(command));
  if (!mayModify) return null;

  // Check if it might affect source files
  if (SOURCE_EXT_PATTERN.test(command)) {
    return `[DELEGATION NOTICE] Bash command may modify source files: ${command}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;
  }
  return null;
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Extract tool name (handle both cases)
  const toolName = data.tool_name || data.toolName || '';

  // Handle Bash tool separately - check for file modification patterns
  if (toolName === 'Bash' || toolName === 'bash') {
    const toolInput = data.tool_input || data.toolInput || {};
    const command = toolInput.command || '';
    const warning = checkBashCommand(command);
    if (warning) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: warning
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
    return;
  }

  // Only check Edit and Write tools
  if (!['Edit', 'Write', 'edit', 'write'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Extract file path (handle nested structures)
  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';

  // No file path? Allow
  if (!filePath) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Check if allowed path
  if (isAllowedPath(filePath)) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Check if source file
  if (isSourceFile(filePath)) {
    const warning = `[DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning
      }
    }));
    return;
  }

  // Not a source file, allow without warning
  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
