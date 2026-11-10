// Hook commands use the braced `${CLAUDE_PLUGIN_ROOT}` form.
//
// Claude Code and Grok substitute the braced placeholder themselves. When
// `args` is present they spawn `command` with no shell, so each path is one
// argument and a plugin root that contains spaces cannot be split. The old
// shell spelling
//   node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...
// is one string. PowerShell on Windows splits it after the closing quote, Node
// receives the plugin directory as its script, and the hook exits at
// package_json_reader. That spelling is accepted on input and repaired.
//
// Unix published caches still rewrite to find-node.sh. nvm/fnm often leave
// `node` off PATH in non-interactive shells, and that rewrite runs under sh.
// A git checkout does not rewrite the manifest (plugin-setup.mjs).

export const UNIX_HOOK_PREFIX = 'sh "${CLAUDE_PLUGIN_ROOT}"/scripts/find-node.sh "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ';

const ROOT = String.raw`(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)`;
const SCRIPT_NAME = /^[A-Za-z0-9._-]+\.mjs$/;

const legacyFindNodePattern = new RegExp(
  String.raw`^sh "${ROOT}\/scripts\/find-node\.sh" "${ROOT}\/scripts\/([^"\s]+)"?(.*)$`,
);
const currentFindNodePattern = new RegExp(
  String.raw`^(?:"\/bin\/sh"|sh) "${ROOT}"\/scripts\/find-node\.sh "${ROOT}"\/scripts\/run\.cjs "${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);
const directRunCjsPattern = new RegExp(
  String.raw`^node\s+"${ROOT}"\/scripts\/run\.cjs\s+"${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);
const absoluteNodeRunCjsPattern = new RegExp(
  String.raw`^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+"${ROOT}"\/scripts\/run\.cjs\s+"${ROOT}"\/scripts\/([^"\s]+)"?(.*)$`,
);

function tailTokens(tail) {
  return String(tail ?? '').trim().split(/\s+/).filter(Boolean);
}

function sameArgs(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

/** Script basename plus tokens that follow it (`start` / `stop`). */
export function parseHookInvocation(hook) {
  if (!hook || typeof hook !== 'object') return null;
  const command = typeof hook.command === 'string' ? hook.command : '';
  const args = Array.isArray(hook.args) ? hook.args.filter((item) => typeof item === 'string') : [];

  if (command === 'node' && args.length >= 2) {
    const runner = args[0].replace(/\\/g, '/');
    const script = args[1].replace(/\\/g, '/').split('/').pop();
    if (runner.endsWith('/scripts/run.cjs') && SCRIPT_NAME.test(script)) {
      return { script, extra: args.slice(2) };
    }
  }

  const match = command.match(currentFindNodePattern)
    ?? command.match(legacyFindNodePattern)
    ?? command.match(directRunCjsPattern);
  if (match) return { script: match[1], extra: tailTokens(match[2]) };

  const absolute = command.match(absoluteNodeRunCjsPattern);
  if (absolute) return { script: absolute[2], extra: tailTokens(absolute[3]) };
  return null;
}

export function windowsExecArgs(script, extra = []) {
  return [
    '${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs',
    `\${CLAUDE_PLUGIN_ROOT}/scripts/${script}`,
    ...extra,
  ];
}

export function unixShellCommand(script, extra = []) {
  const tail = extra.length > 0 ? ` ${extra.join(' ')}` : '';
  return `${UNIX_HOOK_PREFIX}"\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}${tail}`;
}

export function hookPrefixForPlatform(platform = process.platform) {
  return platform === 'win32' ? 'node' : UNIX_HOOK_PREFIX;
}

/**
 * Rewrite one shell command to the Unix find-node form.
 * Windows output is not a string: `normalizeHooksDataForPlatform` writes
 * `command` plus `args` so no shell can split the plugin root.
 */
export function normalizeHookCommand(command, prefix = UNIX_HOOK_PREFIX) {
  if (prefix !== UNIX_HOOK_PREFIX) return command;
  const parsed = parseHookInvocation({ command });
  if (!parsed) return command;
  return unixShellCommand(parsed.script, parsed.extra);
}

export function normalizeHooksDataForPlatform(data, platform = process.platform) {
  let patched = false;

  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        const parsed = parseHookInvocation(hook);
        if (!parsed) continue;

        if (platform === 'win32') {
          const nextArgs = windowsExecArgs(parsed.script, parsed.extra);
          if (hook.command === 'node' && sameArgs(hook.args, nextArgs)) continue;
          hook.command = 'node';
          hook.args = nextArgs;
          patched = true;
          continue;
        }

        const nextCommand = unixShellCommand(parsed.script, parsed.extra);
        const hadArgs = Array.isArray(hook.args);
        if (hook.command === nextCommand && !hadArgs) continue;
        hook.command = nextCommand;
        if (hadArgs) delete hook.args;
        patched = true;
      }
    }
  }

  return patched;
}
