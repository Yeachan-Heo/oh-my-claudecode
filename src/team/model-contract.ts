import { spawnSync } from 'child_process';
import { validateTeamName } from './team-name.js';

export type CliAgentType = 'claude' | 'codex' | 'gemini';

export interface CliAgentContract {
  agentType: CliAgentType;
  binary: string;
  installInstructions: string;
  buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
  parseOutput(rawOutput: string): string;
}

export interface WorkerLaunchConfig {
  teamName: string;
  workerName: string;
  model?: string;
  cwd: string;
  extraFlags?: string[];
}

const CONTRACTS: Record<CliAgentType, CliAgentContract> = {
  claude: {
    agentType: 'claude',
    binary: 'claude',
    installInstructions: 'Install Claude CLI: https://claude.ai/download',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
  codex: {
    agentType: 'codex',
    binary: 'codex',
    installInstructions: 'Install Codex CLI: npm install -g @openai/codex',
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--full-auto', '--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
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
        } catch {
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
    buildLaunchArgs(model?: string, extraFlags: string[] = []): string[] {
      const args = ['--yolo'];
      if (model) args.push('--model', model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput: string): string {
      return rawOutput.trim();
    },
  },
};

export function getContract(agentType: CliAgentType): CliAgentContract {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(', ')}`);
  }
  return contract;
}

export function isCliAvailable(agentType: CliAgentType): boolean {
  const contract = getContract(agentType);
  try {
    const result = spawnSync(contract.binary, ['--version'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function validateCliAvailable(agentType: CliAgentType): void {
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}

export function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}

export function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[] {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const args = buildLaunchArgs(agentType, config);
  return [contract.binary, ...args];
}

export function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string {
  return buildWorkerArgv(agentType, config)
    .map((part) => `'${part.replace(/'/g, `'\"'\"'`)}'`)
    .join(' ');
}

export function getWorkerEnv(teamName: string, workerName: string, agentType: CliAgentType): Record<string, string> {
  validateTeamName(teamName);
  return {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType,
  };
}

export function parseCliOutput(agentType: CliAgentType, rawOutput: string): string {
  return getContract(agentType).parseOutput(rawOutput);
}
