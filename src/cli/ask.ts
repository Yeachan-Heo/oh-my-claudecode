import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { constants as osConstants } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { isExternalLLMDisabled } from '../lib/security-config.js';

export const ASK_USAGE = [
  'Usage: omc ask <claude|codex|gemini> <question or task>',
  '   or: omc ask <claude|codex|gemini> -p "<prompt>"',
  '   or: omc ask <claude|codex|gemini> --print "<prompt>"',
  '   or: omc ask <claude|codex|gemini> --prompt "<prompt>"',
  '   or: omc ask <claude|codex|gemini> --agent-prompt <role> "<prompt>"',
  '   or: omc ask <claude|codex|gemini> --agent-prompt=<role> --prompt "<prompt>"',
].join('\n');

const ASK_PROVIDERS = ['claude', 'codex', 'gemini'] as const;
export type AskProvider = (typeof ASK_PROVIDERS)[number];
const ASK_PROVIDER_SET = new Set<string>(ASK_PROVIDERS);

const ASK_AGENT_PROMPT_FLAG = '--agent-prompt';
const SAFE_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
const ASK_ADVISOR_SCRIPT_ENV = 'OMC_ASK_ADVISOR_SCRIPT';
const ASK_ADVISOR_SCRIPT_ENV_ALIAS = 'OMX_ASK_ADVISOR_SCRIPT';
const ASK_ORIGINAL_TASK_ENV = 'OMC_ASK_ORIGINAL_TASK';

export interface ParsedAskArgs {
  provider: AskProvider;
  prompt: string;
  agentPromptRole?: string;
}

function askUsageError(reason: string): Error {
  return new Error(`${reason}\n${ASK_USAGE}`);
}

function warnDeprecatedAlias(alias: string, canonical: string): void {
  process.stderr.write(`[ask] DEPRECATED: ${alias} is deprecated; use ${canonical} instead.\n`);
}

function getPackageRoot(): string {
  if (typeof __dirname !== 'undefined' && __dirname) {
    const currentDirName = basename(__dirname);
    const parentDirName = basename(dirname(__dirname));

    if (currentDirName === 'bridge') {
      return join(__dirname, '..');
    }

    if (currentDirName === 'cli' && (parentDirName === 'src' || parentDirName === 'dist')) {
      return join(__dirname, '..', '..');
    }
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '..', '..');
  } catch {
    return process.cwd();
  }
}

function resolveAskPromptsDir(
  cwd: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHomeOverride = env.CODEX_HOME?.trim();
  if (codexHomeOverride) {
    return join(codexHomeOverride, 'prompts');
  }

  try {
    const scopePath = join(cwd, '.omx', 'setup-scope.json');
    if (existsSync(scopePath)) {
      const parsed = JSON.parse(readFileSync(scopePath, 'utf-8')) as Partial<{ scope: string }>;
      if (parsed.scope === 'project' || parsed.scope === 'project-local') {
        return join(cwd, '.codex', 'prompts');
      }
    }
  } catch {
    // Ignore malformed persisted scope and fall back to package agents.
  }

  return join(packageRoot, 'agents');
}

async function resolveAgentPromptContent(role: string, promptsDir: string): Promise<string> {
  const normalizedRole = role.trim().toLowerCase();
  if (!SAFE_ROLE_PATTERN.test(normalizedRole)) {
    throw new Error(`[ask] invalid --agent-prompt role "${role}". Expected lowercase role names like "executor" or "test-engineer".`);
  }

  if (!existsSync(promptsDir)) {
    throw new Error(`[ask] prompts directory not found: ${promptsDir}.`);
  }

  const promptPath = join(promptsDir, `${normalizedRole}.md`);
  if (!existsSync(promptPath)) {
    const files = await readdir(promptsDir).catch(() => [] as string[]);
    const availableRoles = files
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -3))
      .sort();
    const availableSuffix = availableRoles.length > 0
      ? ` Available roles: ${availableRoles.join(', ')}.`
      : '';
    throw new Error(`[ask] --agent-prompt role "${normalizedRole}" not found in ${promptsDir}.${availableSuffix}`);
  }

  const content = (await readFile(promptPath, 'utf-8')).trim();
  if (!content) {
    throw new Error(`[ask] --agent-prompt role "${normalizedRole}" is empty: ${promptPath}`);
  }

  return content;
}

export function parseAskArgs(args: readonly string[]): ParsedAskArgs {
  const [providerRaw, ...rest] = args;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !ASK_PROVIDER_SET.has(provider)) {
    throw askUsageError(`Invalid provider "${providerRaw || ''}". Expected one of: ${ASK_PROVIDERS.join(', ')}.`);
  }

  if (rest.length === 0) {
    throw askUsageError('Missing prompt text.');
  }

  let agentPromptRole: string | undefined;
  let prompt = '';

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === ASK_AGENT_PROMPT_FLAG) {
      const role = rest[i + 1]?.trim();
      if (!role || role.startsWith('-')) {
        throw askUsageError('Missing role after --agent-prompt.');
      }
      agentPromptRole = role;
      i += 1;
      continue;
    }

    if (token.startsWith(`${ASK_AGENT_PROMPT_FLAG}=`)) {
      const role = token.slice(`${ASK_AGENT_PROMPT_FLAG}=`.length).trim();
      if (!role) {
        throw askUsageError('Missing role after --agent-prompt=');
      }
      agentPromptRole = role;
      continue;
    }

    if (token === '-p' || token === '--print' || token === '--prompt') {
      prompt = rest.slice(i + 1).join(' ').trim();
      break;
    }

    if (token.startsWith('-p=') || token.startsWith('--print=') || token.startsWith('--prompt=')) {
      const inlinePrompt = token.split('=').slice(1).join('=').trim();
      const remainder = rest.slice(i + 1).join(' ').trim();
      prompt = [inlinePrompt, remainder].filter(Boolean).join(' ').trim();
      break;
    }

    prompt = [prompt, token].filter(Boolean).join(' ').trim();
  }

  if (!prompt) {
    throw askUsageError('Missing prompt text.');
  }

  return {
    provider: provider as AskProvider,
    prompt,
    ...(agentPromptRole ? { agentPromptRole } : {}),
  };
}

export function resolveAskAdvisorScriptPath(
  packageRoot = getPackageRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const canonical = env[ASK_ADVISOR_SCRIPT_ENV]?.trim();
  if (canonical) {
    return isAbsolute(canonical) ? canonical : join(packageRoot, canonical);
  }

  const alias = env[ASK_ADVISOR_SCRIPT_ENV_ALIAS]?.trim();
  if (alias) {
    warnDeprecatedAlias(ASK_ADVISOR_SCRIPT_ENV_ALIAS, ASK_ADVISOR_SCRIPT_ENV);
    return isAbsolute(alias) ? alias : join(packageRoot, alias);
  }

  return join(packageRoot, 'scripts', 'run-provider-advisor.js');
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;

  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === 'number' && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }

  return 1;
}

export async function askCommand(args: string[]): Promise<void> {
  const parsed = parseAskArgs(args);

  if (parsed.provider !== 'claude' && isExternalLLMDisabled()) {
    throw new Error(
      `[ask] External LLM provider "${parsed.provider}" is blocked by security policy ` +
      `(disableExternalLLM). Only "claude" is allowed in the current security configuration.`,
    );
  }

  const packageRoot = getPackageRoot();
  const advisorScriptPath = resolveAskAdvisorScriptPath(packageRoot);
  const promptsDir = resolveAskPromptsDir(process.cwd(), packageRoot, process.env);

  if (!existsSync(advisorScriptPath)) {
    throw new Error(`[ask] advisor script not found: ${advisorScriptPath}`);
  }

  let finalPrompt = parsed.prompt;
  if (parsed.agentPromptRole) {
    const agentPromptContent = await resolveAgentPromptContent(parsed.agentPromptRole, promptsDir);
    finalPrompt = `${agentPromptContent}\n\n${parsed.prompt}`;
  }

  const child = spawnSync(
    process.execPath,
    [advisorScriptPath, parsed.provider, finalPrompt],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [ASK_ORIGINAL_TASK_ENV]: parsed.prompt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (child.stdout && child.stdout.length > 0) {
    process.stdout.write(child.stdout);
  }
  if (child.stderr && child.stderr.length > 0) {
    process.stderr.write(child.stderr);
  }

  if (child.error) {
    throw new Error(`[ask] failed to launch advisor script: ${child.error.message}`);
  }

  const status = typeof child.status === 'number'
    ? child.status
    : resolveSignalExitCode(child.signal);

  if (status !== 0) {
    process.exitCode = status;
  }
}
