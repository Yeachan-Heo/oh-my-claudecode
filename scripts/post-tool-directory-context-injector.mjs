#!/usr/bin/env node

/**
 * PostToolUse Hook: Directory Context Injector (issue #4006 finding 1)
 *
 * Injects the nearest README.md / AGENTS.md files, walking up from the
 * accessed file to the working directory root, into context when Claude
 * reads or edits a file.
 *
 * Claude Code's own memory loader discovers nested CLAUDE.md only, so a
 * nested AGENTS.md — which is exactly what `deepinit` generates — is never
 * loaded natively. The directory-readme-injector hook implementation existed
 * but was registered nowhere, so no install ever ran it and every nested
 * deepinit file was inert.
 *
 * Dedup is per session and per resolved context-file path (see the hook's
 * storage module), so the same AGENTS.md is injected at most once per session
 * no matter how many files under it are touched.
 */

import { isAbsolute, join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readStdin } from './lib/stdin.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getRuntimeBaseDir() {
  return process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
}

// Dynamic import — graceful no-op when dist/ is not built (first run / dev)
let createDirectoryReadmeInjectorHook = null;
try {
  const runtimeBase = getRuntimeBaseDir();
  const mod = await import(
    pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'directory-readme-injector', 'index.js')).href
  );
  createDirectoryReadmeInjectorHook = mod.createDirectoryReadmeInjectorHook;
} catch {
  // dist not available — skip directory context injection silently
}

/**
 * Extract the primary file path from tool input.
 * All tracked tools (read, write, edit, multiedit) expose file_path at the
 * top level of tool_input.
 */
function extractFilePath(toolInput) {
  if (!toolInput) return null;
  return toolInput.file_path || toolInput.path || null;
}

async function main() {
  // Honor the documented kill switches (issues #838, #3253) with the same
  // `post-tool-use` event token as the other PostToolUse hooks.
  const skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map((s) => s.trim());
  if (
    process.env.DISABLE_OMC === '1' ||
    process.env.DISABLE_OMC === 'true' ||
    skipHooks.includes('post-tool-use')
  ) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch { /* ignore parse errors */ }

    if (!createDirectoryReadmeInjectorHook) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const toolName = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.toolInput || {};
    const sessionId = data.session_id || data.sessionId || 'unknown';
    const cwd = data.cwd || process.cwd();

    const rawPath = extractFilePath(toolInput);
    if (!rawPath) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);

    const hook = createDirectoryReadmeInjectorHook(cwd);
    const contextText = hook.processToolExecution(toolName, filePath, sessionId);

    if (contextText) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: contextText,
        },
      }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } catch {
    // Always continue on error — context injection is additive only
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
