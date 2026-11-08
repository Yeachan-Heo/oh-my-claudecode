// Hook commands use the braced `${CLAUDE_PLUGIN_ROOT}` form.
//
// Claude Code substitutes the braced placeholder itself before handing the
// command to a shell. The bare `$CLAUDE_PLUGIN_ROOT` form instead relies on the
// shell expanding an environment variable, which only holds where a POSIX shell
// actually runs the command. The Windows prefix invokes `node` directly with no
// `sh` in front of it, so there the bare form is never expanded from the
// environment and the plugin root resolves to nothing — `node` then tries to
// load `<drive>:\scripts\run.cjs` and the CJS loader fails at session start.
//
// Under `sh` both forms expand identically, so the braced form is a no-op on
// Unix/macOS and the only form that can work on native Windows.
export const WINDOWS_HOOK_PREFIX = 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ';
export const UNIX_HOOK_PREFIX = 'sh "${CLAUDE_PLUGIN_ROOT}"/scripts/find-node.sh "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ';

export function hookPrefixForPlatform(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_HOOK_PREFIX : UNIX_HOOK_PREFIX;
}

export function normalizeHookCommand(command, prefix = hookPrefixForPlatform()) {
  // Both the bare and braced spellings are accepted on input so that manifests
  // written by any earlier version are repaired rather than left alone; every
  // branch emits the braced form.
  const root = String.raw`(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)`;

  const legacyFindNodePattern = new RegExp(
    String.raw`^sh "${root}\/scripts\/find-node\.sh" "${root}\/scripts\/([^"\s]+)"?(.*)$`,
  );
  const currentFindNodePattern = new RegExp(
    String.raw`^(?:"\/bin\/sh"|sh) "${root}"\/scripts\/find-node\.sh "${root}"\/scripts\/run\.cjs "${root}"\/scripts\/([^"\s]+)"?(.*)$`,
  );
  const directRunCjsPattern = new RegExp(
    String.raw`^node\s+"${root}"\/scripts\/run\.cjs\s+"${root}"\/scripts\/([^"\s]+)"?(.*)$`,
  );
  const absoluteNodeRunCjsPattern = new RegExp(
    String.raw`^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+"${root}"\/scripts\/run\.cjs\s+"${root}"\/scripts\/([^"\s]+)"?(.*)$`,
  );

  const match = command.match(currentFindNodePattern)
    ?? command.match(legacyFindNodePattern)
    ?? command.match(directRunCjsPattern);
  if (match) return `${prefix}"\${CLAUDE_PLUGIN_ROOT}"/scripts/${match[1]}${match[2]}`;

  const absNodeMatch = command.match(absoluteNodeRunCjsPattern);
  if (absNodeMatch) return `${prefix}"\${CLAUDE_PLUGIN_ROOT}"/scripts/${absNodeMatch[2]}${absNodeMatch[3]}`;

  return command;
}

export function normalizeHooksDataForPlatform(data, platform = process.platform) {
  const prefix = hookPrefixForPlatform(platform);
  let patched = false;

  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string') continue;
        const nextCommand = normalizeHookCommand(hook.command, prefix);
        if (hook.command !== nextCommand) {
          hook.command = nextCommand;
          patched = true;
        }
      }
    }
  }

  return patched;
}
