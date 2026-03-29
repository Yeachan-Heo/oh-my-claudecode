#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import process from 'process';

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};
const SHOULD_USE_WINDOWS_SHELL = process.platform === 'win32';

/**
 * Build CLI args for a given provider.
 * - claude: `claude -p <prompt>`
 * - codex: `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
 * - gemini: `gemini -p <prompt> --yolo`
 */
function buildProviderArgs(provider, prompt, { pipePromptViaStdin = false } = {}) {
  if (provider === 'codex') {
    return ['exec', '--dangerously-bypass-approvals-and-sandbox', pipePromptViaStdin ? '-' : prompt];
  }
  if (provider === 'gemini') {
    return pipePromptViaStdin ? ['--yolo'] : ['-p', prompt, '--yolo'];
  }
  return ['-p', prompt];
}

function shouldPipePromptViaStdin(provider) {
  return SHOULD_USE_WINDOWS_SHELL && (provider === 'codex' || provider === 'gemini');
}

const ASK_ORIGINAL_TASK_ENV = 'OMC_ASK_ORIGINAL_TASK';
const ASK_ORIGINAL_TASK_ENV_ALIAS = 'OMX_ASK_ORIGINAL_TASK';

function usage() {
  console.error('Usage: omc ask <claude|codex|gemini> "<prompt>"');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|codex|gemini> <prompt...>');
  console.error('                 or: node scripts/run-provider-advisor.js claude --print "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js gemini --prompt "<prompt>"');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const [providerRaw, ...rest] = argv;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !(provider in PROVIDER_BINARIES)) {
    usage();
    process.exit(1);
  }

  if (rest.length === 0) {
    usage();
    process.exit(1);
  }

  if (rest[0] === '-p' || rest[0] === '--print' || rest[0] === '--prompt') {
    const prompt = rest.slice(1).join(' ').trim();
    if (!prompt) {
      usage();
      process.exit(1);
    }
    return { provider, prompt };
  }

  return { provider, prompt: rest.join(' ').trim() };
}

// Strip Claude session markers so provider advisors do not detect or inherit the active Claude Code session.
const CLAUDE_SESSION_STRIPPED_ENV_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
  'CLAUDECODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
]);
const CODEX_STRIPPED_ENV_VARS = new Set(['RUST_LOG', 'RUST_BACKTRACE', 'RUST_LIB_BACKTRACE']);

function buildProviderEnv(provider, env = process.env) {
  const strippedEnvVars = provider === 'codex'
    ? new Set([...CLAUDE_SESSION_STRIPPED_ENV_VARS, ...CODEX_STRIPPED_ENV_VARS])
    : CLAUDE_SESSION_STRIPPED_ENV_VARS;

  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !strippedEnvVars.has(key)),
  );
}

function ensureBinary(provider, binary) {
  const probe = spawnSync(binary, ['--version'], {
    stdio: 'ignore',
    encoding: 'utf8',
    env: buildProviderEnv(provider),
    shell: SHOULD_USE_WINDOWS_SHELL,
  });

  const isMissingOnWindowsShell = SHOULD_USE_WINDOWS_SHELL
    && probe.status !== 0
    && (() => {
      const whereResult = spawnSync('where', [binary], {
        encoding: 'utf8',
        env: buildProviderEnv(provider),
      });
      return whereResult.status !== 0 || !whereResult.stdout?.trim();
    })();

  if ((probe.error && probe.error.code === 'ENOENT') || isMissingOnWindowsShell) {
    const verify = `${binary} --version`;
    console.error(`[ask-${binary}] Missing required local CLI binary: ${binary}`);
    console.error(`[ask-${binary}] Install/configure ${binary} CLI, then verify with: ${verify}`);
    process.exit(1);
  }
}

function buildSummary(exitCode, output) {
  if (exitCode === 0) {
    return 'Provider completed successfully. Review the raw output for details.';
  }

  const firstLine = output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine
    ? `Provider command failed (exit ${exitCode}): ${firstLine}`
    : `Provider command failed with exit code ${exitCode}.`;
}

function buildActionItems(exitCode) {
  if (exitCode === 0) {
    return [
      'Review the response and extract decisions you want to apply.',
      'Capture follow-up implementation tasks if needed.',
    ];
  }

  return [
    'Inspect the raw output error details.',
    'Fix CLI/auth/environment issues and rerun the command.',
  ];
}

function resolveOriginalTask(prompt) {
  const canonical = process.env[ASK_ORIGINAL_TASK_ENV];
  if (canonical && canonical.trim()) {
    return canonical;
  }

  const alias = process.env[ASK_ORIGINAL_TASK_ENV_ALIAS];
  if (alias && alias.trim()) {
    console.error(`[ask] DEPRECATED: ${ASK_ORIGINAL_TASK_ENV_ALIAS} is deprecated; use ${ASK_ORIGINAL_TASK_ENV} instead.`);
    return alias;
  }

  return prompt;
}

async function writeArtifact({ provider, originalTask, finalPrompt, rawOutput, exitCode }) {
  const root = process.cwd();
  const artifactDir = join(root, '.omc', 'artifacts', 'ask');
  const slug = slugify(originalTask);
  const timestamp = timestampToken();
  const artifactPath = join(artifactDir, `${provider}-${slug}-${timestamp}.md`);

  const summary = buildSummary(exitCode, rawOutput);
  const actionItems = buildActionItems(exitCode);

  const body = [
    `# ${provider} advisor artifact`,
    '',
    `- Provider: ${provider}`,
    `- Exit code: ${exitCode}`,
    `- Created at: ${new Date().toISOString()}`,
    '',
    '## Original task',
    '',
    originalTask,
    '',
    '## Final prompt',
    '',
    finalPrompt,
    '',
    '## Raw output',
    '',
    '```text',
    rawOutput || '(no output)',
    '```',
    '',
    '## Concise summary',
    '',
    summary,
    '',
    '## Action items',
    '',
    ...actionItems.map((item) => `- ${item}`),
    '',
  ].join('\n');

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, body, 'utf8');
  return artifactPath;
}

async function main() {
  const { provider, prompt } = parseArgs(process.argv.slice(2));
  const binary = PROVIDER_BINARIES[provider];

  ensureBinary(provider, binary);

  const pipePromptViaStdin = shouldPipePromptViaStdin(provider);
  const providerArgs = buildProviderArgs(provider, prompt, { pipePromptViaStdin });
  const run = spawnSync(binary, providerArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: buildProviderEnv(provider),
    shell: SHOULD_USE_WINDOWS_SHELL,
    ...(pipePromptViaStdin ? { input: prompt } : {}),
  });

  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  const rawOutput = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n\n' : '');
  const exitCode = typeof run.status === 'number' ? run.status : 1;

  const artifactPath = await writeArtifact({
    provider,
    originalTask: resolveOriginalTask(prompt),
    finalPrompt: prompt,
    rawOutput,
    exitCode,
  });

  console.log(artifactPath);

  if (run.error) {
    console.error(`[ask-${provider}] ${run.error.message}`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(`[run-provider-advisor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
