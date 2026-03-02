import { spawnSync } from 'child_process';
import { isAbsolute, win32 as win32Path } from 'path';
import { validateTeamName } from './team-name.js';
const resolvedPathCache = new Map();
const UNTRUSTED_PATH_PATTERNS = [
    /^\/tmp(\/|$)/,
    /^\/var\/tmp(\/|$)/,
    /^\/dev\/shm(\/|$)/,
];
function getTrustedPrefixes() {
    const trusted = [
        '/usr/local/bin',
        '/usr/bin',
        '/opt/homebrew/',
    ];
    const home = process.env.HOME;
    if (home) {
        trusted.push(`${home}/.local/bin`);
        trusted.push(`${home}/.nvm/`);
        trusted.push(`${home}/.cargo/bin`);
    }
    const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? '')
        .split(':')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => isAbsolute(part));
    trusted.push(...custom);
    return trusted;
}
function isTrustedPrefix(resolvedPath) {
    const normalized = normalize(resolvedPath);
    return getTrustedPrefixes().some(prefix => normalized.startsWith(normalize(prefix)));
}
function assertBinaryName(binary) {
    if (!/^[A-Za-z0-9._-]+$/.test(binary)) {
        throw new Error(`Invalid CLI binary name: ${binary}`);
    }
}
/** @deprecated Backward-compat shim; non-interactive shells should generally skip RC files. */
export function shouldLoadShellRc() {
    return false;
}
/** @deprecated Backward-compat shim retained for API compatibility. */
export function resolveCliBinaryPath(binary) {
    assertBinaryName(binary);
    const cached = resolvedPathCache.get(binary);
    if (cached)
        return cached;
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(finder, [binary], {
        timeout: 5000,
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`CLI binary '${binary}' not found in PATH`);
    }
    const stdout = result.stdout?.toString().trim() ?? '';
    const firstLine = stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '';
    if (!firstLine) {
        throw new Error(`CLI binary '${binary}' not found in PATH`);
    }
    const resolvedPath = normalize(firstLine);
    if (!isAbsolute(resolvedPath)) {
        throw new Error(`Resolved CLI binary '${binary}' to relative path`);
    }
    if (UNTRUSTED_PATH_PATTERNS.some(pattern => pattern.test(resolvedPath))) {
        throw new Error(`Resolved CLI binary '${binary}' to untrusted location: ${resolvedPath}`);
    }
    if (!isTrustedPrefix(resolvedPath)) {
        console.warn(`[omc:cli-security] CLI binary '${binary}' resolved to non-standard path: ${resolvedPath}`);
    }
    resolvedPathCache.set(binary, resolvedPath);
    return resolvedPath;
}
/** @deprecated Backward-compat shim retained for API compatibility. */
export function clearResolvedPathCache() {
    resolvedPathCache.clear();
}
/** @deprecated Backward-compat shim retained for API compatibility. */
export function validateCliBinaryPath(binary) {
    try {
        const resolvedPath = resolveCliBinaryPath(binary);
        return { valid: true, binary, resolvedPath };
    }
    catch (error) {
        return {
            valid: false,
            binary,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
export const _testInternals = {
    UNTRUSTED_PATH_PATTERNS,
    getTrustedPrefixes,
};
const CONTRACTS = {
    claude: {
        agentType: 'claude',
        binary: 'claude',
        installInstructions: 'Install Claude CLI: https://claude.ai/download',
        buildLaunchArgs(model, extraFlags = []) {
            const args = ['--dangerously-skip-permissions'];
            if (model)
                args.push('--model', model);
            return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
            return rawOutput.trim();
        },
    },
    codex: {
        agentType: 'codex',
        binary: 'codex',
        installInstructions: 'Install Codex CLI: npm install -g @openai/codex',
        supportsPromptMode: true,
        // Codex accepts prompt as a positional argument (no flag needed):
        //   codex [OPTIONS] [PROMPT]
        buildLaunchArgs(model, extraFlags = []) {
            const args = ['--dangerously-bypass-approvals-and-sandbox'];
            if (model)
                args.push('--model', model);
            return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
            // Codex outputs JSONL — extract the last assistant message
            const lines = rawOutput.trim().split('\n').filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const parsed = JSON.parse(lines[i]);
                    if (parsed.type === 'message' && parsed.role === 'assistant') {
                        return parsed.content ?? rawOutput;
                    }
                    if (parsed.type === 'result' || parsed.output) {
                        return parsed.output ?? parsed.result ?? rawOutput;
                    }
                }
                catch {
                    // not JSON, skip
                }
            }
            return rawOutput.trim();
        },
    },
    gemini: {
        agentType: 'gemini',
        binary: 'gemini',
        installInstructions: 'Install Gemini CLI: npm install -g @google/gemini-cli',
        supportsPromptMode: true,
        promptModeFlag: '-p',
        buildLaunchArgs(model, extraFlags = []) {
            const args = ['--yolo'];
            if (model)
                args.push('--model', model);
            return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
            return rawOutput.trim();
        },
    },
};
export function getContract(agentType) {
    const contract = CONTRACTS[agentType];
    if (!contract) {
        throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
    }
    return contract;
}
function validateBinaryRef(binary) {
    if (isAbsolute(binary))
        return;
    if (/^[A-Za-z0-9._-]+$/.test(binary))
        return;
    throw new Error(`Unsafe CLI binary reference: ${binary}`);
}
function resolveBinaryPath(binary) {
    validateBinaryRef(binary);
    if (isAbsolute(binary))
        return binary;
    try {
        const resolver = process.platform === 'win32' ? 'where' : 'which';
        const result = spawnSync(resolver, [binary], { timeout: 5000, encoding: 'utf8' });
        if (result.status !== 0)
            return binary;
        const lines = result.stdout
            ?.split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean) ?? [];
        const firstPath = lines[0];
        const isResolvedAbsolute = !!firstPath && (isAbsolute(firstPath) || win32Path.isAbsolute(firstPath));
        return isResolvedAbsolute ? firstPath : binary;
    }
    catch {
        return binary;
    }
}
export function isCliAvailable(agentType) {
    const contract = getContract(agentType);
    try {
        const resolvedBinary = resolveBinaryPath(contract.binary);
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedBinary)) {
            const comspec = process.env.COMSPEC || 'cmd.exe';
            const result = spawnSync(comspec, ['/d', '/s', '/c', `"${resolvedBinary}" --version`], { timeout: 5000 });
            return result.status === 0;
        }
        const result = spawnSync(resolvedBinary, ['--version'], { timeout: 5000 });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
export function validateCliAvailable(agentType) {
    if (!isCliAvailable(agentType)) {
        const contract = getContract(agentType);
        throw new Error(`CLI agent '${agentType}' not found. ${contract.installInstructions}`);
    }
}
export function buildLaunchArgs(agentType, config) {
    return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}
export function buildWorkerArgv(agentType, config) {
    validateTeamName(config.teamName);
    const contract = getContract(agentType);
    const binary = resolveBinaryPath(contract.binary);
    const args = buildLaunchArgs(agentType, config);
    return [binary, ...args];
}
export function buildWorkerCommand(agentType, config) {
    return buildWorkerArgv(agentType, config)
        .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
        .join(' ');
}
export function getWorkerEnv(teamName, workerName, agentType) {
    validateTeamName(teamName);
    return {
        OMC_TEAM_WORKER: `${teamName}/${workerName}`,
        OMC_TEAM_NAME: teamName,
        OMC_WORKER_AGENT_TYPE: agentType,
    };
}
export function parseCliOutput(agentType, rawOutput) {
    return getContract(agentType).parseOutput(rawOutput);
}
/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export function isPromptModeAgent(agentType) {
    const contract = getContract(agentType);
    return !!contract.supportsPromptMode;
}
/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
export function getPromptModeArgs(agentType, instruction) {
    const contract = getContract(agentType);
    if (!contract.supportsPromptMode) {
        return [];
    }
    // If a flag is defined (e.g. gemini's '-p'), prepend it; otherwise the
    // instruction is passed as a positional argument (e.g. codex [PROMPT]).
    if (contract.promptModeFlag) {
        return [contract.promptModeFlag, instruction];
    }
    return [instruction];
}
//# sourceMappingURL=model-contract.js.map