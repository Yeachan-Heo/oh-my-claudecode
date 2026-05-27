export const WINDOWS_HOOK_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';
export const UNIX_HOOK_PREFIX = 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';

export function hookPrefixForPlatform(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_HOOK_PREFIX : UNIX_HOOK_PREFIX;
}

export function normalizeHookCommand(command, prefix = hookPrefixForPlatform()) {
  const legacyFindNodePattern =
    /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"\s]+)"?(.*)$/;
  const currentFindNodePattern =
    /^(?:"\/bin\/sh"|sh) "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs "\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;
  const directRunCjsPattern =
    /^node\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;
  const absoluteNodeRunCjsPattern =
    /^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^"\s]+)"?(.*)$/;

  const match = command.match(currentFindNodePattern)
    ?? command.match(legacyFindNodePattern)
    ?? command.match(directRunCjsPattern);
  if (match) return `${prefix}"$CLAUDE_PLUGIN_ROOT"/scripts/${match[1]}${match[2]}`;

  const absNodeMatch = command.match(absoluteNodeRunCjsPattern);
  if (absNodeMatch) return `${prefix}"$CLAUDE_PLUGIN_ROOT"/scripts/${absNodeMatch[2]}${absNodeMatch[3]}`;

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
