#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import process from 'process';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex: 'codex',
  // gemini: dynamically resolved — `agy` (Antigravity CLI) takes precedence,
  // falls back to `gemini` CLI when agy is not installed. See resolveGeminiBinary().
  gemini: null,
  grok: 'grok',
  cursor: 'cursor-agent',
};
const SHOULD_USE_WINDOWS_SHELL = process.platform === 'win32';

/**
 * Resolve the binary to use for the `gemini` provider.
 *
 * Google Antigravity CLI (`agy`) supersedes the legacy Gemini CLI (`gemini`).
 * Both support a non-interactive print mode:
 *   - agy:    `agy --print <prompt>`
 *   - gemini: `gemini -p <prompt> --yolo`
 *
 * Resolution order: agy → gemini. If neither is available, returns 'agy' so
 * ensureBinary() produces a clear installation error.
 */
function resolveGeminiBinary(env) {
  for (const bin of ['agy', 'gemini']) {
    const probe = spawnSync(bin, ['--version'], {
      stdio: 'ignore',
      encoding: 'utf8',
      env,
      shell: SHOULD_USE_WINDOWS_SHELL,
    });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

/**
 * Build CLI args for a given provider.
 * - claude:  `claude -p <prompt>` (or `claude -p` reading the prompt from stdin)
 * - codex:   `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
 * - gemini/agy:    `agy --print <prompt>`  (Antigravity CLI, preferred)
 * - gemini/gemini: `gemini -p <prompt> --yolo`  (legacy Gemini CLI, fallback)
 * - grok:    `grok -p <prompt> --always-approve`
 * - cursor:  `cursor-agent --print --force --trust --sandbox disabled <prompt>`
 */
function buildProviderArgs(provider, prompt, { pipePromptViaStdin = false, resolvedBinary = null } = {}) {
  if (provider === 'codex') {
    return ['exec', '--dangerously-bypass-approvals-and-sandbox', pipePromptViaStdin ? '-' : prompt];
  }
  if (provider === 'gemini') {
    if (resolvedBinary === 'agy') {
      // agy --print always takes the prompt as a positional arg.
      // Stdin prompt piping is not supported by agy's --print mode.
      return ['--print', prompt];
    }
    // Legacy gemini CLI
    return pipePromptViaStdin ? ['--yolo'] : ['-p', prompt, '--yolo'];
  }
  if (provider === 'grok') {
    // Grok's headless mode always takes the prompt as a `-p` arg; its stdin is
    // for ACP JSON-RPC, not the prompt, so it never uses the stdin pipe path.
    return ['-p', prompt, '--always-approve'];
  }
  if (provider === 'cursor') {
    // Cursor Agent's print mode takes the prompt as a positional arg. Keep stdin
    // closed so it cannot interpret advisor prompt bytes as interactive input.
    return ['--print', '--force', '--trust', '--sandbox', 'disabled', prompt];
  }
  // claude: `claude -p` reads the prompt from stdin when no prompt arg is given.
  return pipePromptViaStdin ? ['-p'] : ['-p', prompt];
}

function shouldPipePromptViaStdin(provider, prompt, { resolvedBinary = null } = {}) {
  if (provider === 'gemini' && resolvedBinary === 'agy') {
    // agy --print does not support stdin prompt piping; always pass as arg.
    return false;
  }
  if (provider === 'codex' || provider === 'gemini') {
    if (typeof prompt === 'string' && (prompt.includes('\n') || prompt.length > 500)) {
      return true;
    }

    return SHOULD_USE_WINDOWS_SHELL;
  }

  // #3221: long/multiline/frontmatter prompts must not be passed to Claude as a
  // raw argv value. Claude's CLI parses a leading `-`/`--`/`---` (YAML
  // frontmatter) token as an option and either errors out or drops the prompt.
  // Route those over stdin (`claude -p` reads the prompt from stdin). Short,
  // single-line, non-option prompts keep the existing `-p <prompt>` behavior.
  if (provider === 'claude') {
    if (typeof prompt !== 'string') {
      return false;
    }

    return prompt.includes('\n') || prompt.length > 500 || /^\s*-/.test(prompt);
  }

  // grok (ACP stdin), cursor-agent (interactive stdin), and any other provider
  // never pipe the prompt.
  return false;
}

const ASK_ORIGINAL_TASK_ENV = 'OMC_ASK_ORIGINAL_TASK';
const ASK_ORIGINAL_TASK_ENV_ALIAS = 'OMX_ASK_ORIGINAL_TASK';

function usage() {
  console.error('Usage: omc ask <claude|codex|gemini|grok|cursor> "<prompt>"');
  console.error('       gemini provider uses agy (Antigravity CLI) when available, falls back to gemini CLI');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|codex|gemini|grok|cursor> <prompt...>');
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

async function writeArtifact({ provider, resolvedBinary, originalTask, finalPrompt, rawOutput, exitCode }) {
  const root = process.cwd();
  const artifactDir = join(await resolveOmcStateRoot(root), 'artifacts', 'ask');
  const slug = slugify(originalTask);
  const timestamp = timestampToken();
  const artifactPath = join(artifactDir, `${provider}-${slug}-${timestamp}.md`);

  const summary = buildSummary(exitCode, rawOutput);
  const actionItems = buildActionItems(exitCode);

  const body = [
    `# ${provider} advisor artifact`,
    '',
    `- Provider: ${provider}`,
    `- Resolved binary: ${resolvedBinary || provider}`,
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

  // Resolve binary: gemini uses agy (preferred) or gemini CLI (fallback).
  const providerEnv = buildProviderEnv(provider);
  let binary;
  if (provider === 'gemini') {
    // Resolution already probes each candidate; skip separate ensureBinary.
    binary = resolveGeminiBinary(providerEnv);
    if (!binary) {
      console.error('[ask-gemini] Missing required CLI binary: agy or gemini');
      console.error('[ask-gemini] Install Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash');
      console.error('[ask-gemini] Or install legacy Gemini CLI: npm install -g @google/gemini-cli');
      process.exit(1);
    }
  } else {
    binary = PROVIDER_BINARIES[provider];
    ensureBinary(provider, binary);
  }

  const pipePromptViaStdin = shouldPipePromptViaStdin(provider, prompt, { resolvedBinary: binary });
  const providerArgs = buildProviderArgs(provider, prompt, { pipePromptViaStdin, resolvedBinary: binary });
  const run = spawnSync(binary, providerArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: providerEnv,
    shell: SHOULD_USE_WINDOWS_SHELL,
    ...(pipePromptViaStdin ? { input: prompt } : { stdio: ['ignore', 'pipe', 'pipe'] }),
  });

  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  const rawOutput = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n\n' : '');
  const exitCode = typeof run.status === 'number' ? run.status : 1;

  const artifactPath = await writeArtifact({
    provider,
    resolvedBinary: binary,
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
