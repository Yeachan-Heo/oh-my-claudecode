import { spawnSync } from 'child_process';
const OMC_CLI_BINARY = 'omc';
const OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
const commandExistsCache = new Map();
function commandExists(command, env) {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const pathValue = env.PATH ?? env.Path ?? '';
    const pathExtValue = process.platform === 'win32' ? env.PATHEXT ?? '' : '';
    const cacheKey = [process.platform, lookupCommand, command, pathValue, pathExtValue].join('\0');
    const cached = commandExistsCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const result = spawnSync(lookupCommand, [command], {
        stdio: 'ignore',
        env,
    });
    const exists = result.status === 0;
    commandExistsCache.set(cacheKey, exists);
    return exists;
}
export function resolveOmcCliPrefix(options = {}) {
    const env = options.env ?? process.env;
    const omcAvailable = options.omcAvailable ?? commandExists(OMC_CLI_BINARY, env);
    if (omcAvailable) {
        return OMC_CLI_BINARY;
    }
    const pluginRoot = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.trim() : '';
    if (pluginRoot) {
        return OMC_PLUGIN_BRIDGE_PREFIX;
    }
    return OMC_CLI_BINARY;
}
export function formatOmcCliInvocation(commandSuffix, options = {}) {
    const suffix = commandSuffix.trim().replace(/^omc\s+/, '');
    return `${resolveOmcCliPrefix(options)} ${suffix}`.trim();
}
export function rewriteOmcCliInvocations(text, options = {}) {
    const prefix = resolveOmcCliPrefix(options);
    if (prefix === OMC_CLI_BINARY || !text.includes('omc ')) {
        return text;
    }
    return text
        .replace(/`omc (?=[^`\r\n]+`)/g, `\`${prefix} `)
        .replace(/(^|\n)([ \t>*-]*)omc (?=\S)/g, `$1$2${prefix} `);
}
//# sourceMappingURL=omc-cli-rendering.js.map