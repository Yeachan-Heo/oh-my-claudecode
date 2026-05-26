'use strict';
/**
 * Windows hook-manifest self-heal (win-hook-heal.cjs)
 *
 * On native Windows the shipped hooks.json bootstraps every hook through
 *   sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...
 * which Claude Code cannot execute on win32 — every hook is mislabeled as a
 * failure with `/usr/bin/sh: cannot execute binary file`.
 *
 * Setup-time rewriting (patchHooksJsonForWindows in src/hooks/setup, and
 * scripts/plugin-setup.mjs) already converts the manifest to the direct
 * `node ... run.cjs` form, but neither runs on a fresh marketplace install:
 * there is no npm postinstall, and the SessionStart:init hook that would trigger
 * the rewrite is itself shipped in the broken sh form. The only hook shipped in
 * the Windows-safe `node ... run.cjs` form is SessionEnd, so run.cjs is the one
 * node entry point Claude Code reaches on Windows. Healing the manifest from
 * there lets a fresh install converge to the working node form after the first
 * session, and re-heals automatically after every plugin update.
 *
 * find-node.sh is intentionally kept on Unix for nvm/fnm Node discovery
 * (issue #892), so this rewrite must only ever be applied on win32. The win32
 * guard lives at the call site (run.cjs); the rewrite itself is platform-neutral
 * so it can be unit-tested on any OS.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3121
 */

const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

// Mirrors patchHooksJsonForWindows (src/hooks/setup/index.ts) so the runtime
// self-heal and the setup-time rewrite always produce identical commands.
//
// Current/cache form:
//   sh|"/bin/sh" "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/X.mjs [args]
const CURRENT_PATTERN =
  /^(?:"\/bin\/sh"|sh) "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs "\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^\s]+)(.*)$/;
// Legacy form:
//   sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
const LEGACY_PATTERN =
  /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"]+)"(.*)$/;

/**
 * Rewrite a single hook command from the sh/find-node bootstrap to the direct
 * `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...` form. Returns the rewritten
 * command, or null when the command does not match a known sh bootstrap form.
 */
function rewriteCommand(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(CURRENT_PATTERN) || command.match(LEGACY_PATTERN);
  if (!m) return null;
  return `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${m[1]}${m[2]}`;
}

/**
 * Rewrite sh+find-node.sh hook commands in <pluginRoot>/hooks/hooks.json to the
 * direct `node run.cjs` form. Best-effort and idempotent: only writes when at
 * least one command actually changed. Returns true when the file was rewritten.
 */
function healWindowsHookManifest(pluginRoot) {
  if (!pluginRoot) return false;

  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return false;

  let content;
  try {
    content = readFileSync(hooksJsonPath, 'utf-8');
  } catch {
    return false;
  }

  // Cheap gate: once the manifest no longer bootstraps through find-node.sh
  // there is nothing to heal, so we avoid parsing on every hook invocation.
  if (!content.includes('find-node.sh')) return false;

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return false;
  }

  let patched = false;
  for (const groups of Object.values(data.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const hook of hooks) {
        const rewritten = rewriteCommand(hook && hook.command);
        if (rewritten) {
          hook.command = rewritten;
          patched = true;
        }
      }
    }
  }

  if (!patched) return false;

  try {
    writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = { healWindowsHookManifest, rewriteCommand };
