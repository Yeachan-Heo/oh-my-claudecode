import { spawnSync } from 'child_process';
import { validateTeamName } from './team-name.js';
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
export function isCliAvailable(agentType) {
    const contract = getContract(agentType);
    try {
        const result = spawnSync(contract.binary, ['--version'], { timeout: 5000, shell: true });
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
    const args = buildLaunchArgs(agentType, config);
    return [contract.binary, ...args];
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