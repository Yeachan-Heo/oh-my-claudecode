export const AUTORESEARCH_HELP = `omc autoresearch - HARD DEPRECATED

This command is no longer the authoritative autoresearch workflow.

Use this flow instead:
  1. /deep-interview --autoresearch "<mission idea>"
     - use deep-interview to generate/setup the mission and evaluator
  2. /oh-my-claudecode:autoresearch
     - run the stateful single-mission autoresearch skill

Key behavior:
  - v1 is single-mission only
  - runtime requires an explicit evaluator script/command
  - non-passing iterations do not stop the run
  - the run stops at an explicit max-runtime ceiling

Legacy CLI examples such as:
  omc autoresearch --mission "..." --eval "..."
  omc autoresearch init ...
  omc autoresearch --resume ...
are hard-deprecated shims and no longer launch the old runtime.
`;
function renderDeprecationMessage(args) {
    const suffix = args.length > 0
        ? `\nReceived legacy arguments: ${args.join(' ')}\n`
        : '\n';
    return `${AUTORESEARCH_HELP}${suffix}`;
}
export function normalizeAutoresearchClaudeArgs(claudeArgs) {
    return [...claudeArgs];
}
export function parseAutoresearchArgs(args) {
    return {
        args: [...args],
        deprecated: true,
    };
}
export async function autoresearchCommand(args) {
    console.log(renderDeprecationMessage(args));
}
//# sourceMappingURL=autoresearch.js.map