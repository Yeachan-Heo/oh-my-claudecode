#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { Buffer } from 'buffer';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(scriptDir, '..');
const compiledCli = join(pluginRoot, 'dist', 'hooks', 'lazycodex-compat', 'cli.js');
const sourceCli = join(pluginRoot, 'src', 'hooks', 'lazycodex-compat', 'cli.ts');
const cliCommand = existsSync(compiledCli)
  ? { command: process.execPath, args: [compiledCli] }
  : existsSync(sourceCli)
    ? { command: 'npx', args: ['tsx', sourceCli] }
    : null;

if (cliCommand === null) {
  process.stdout.write(`${JSON.stringify({
    continue: true,
    lazycodexCompat: {
      normalized: {
        eventName: process.argv[2] || 'UserPromptSubmit',
        portableEventId: 'prompt-submitted',
        cwd: process.cwd(),
        sessionId: 'unknown-session',
      },
      decisions: [
        {
          behavior: 'malformed-input',
          decision: 'needs-evidence',
          reason: 'compiled LazyCodex compatibility CLI is missing',
        },
      ],
      sideEffects: [],
    },
  })}\n`);
  process.exit(0);
}

const result = spawnSync(
  cliCommand.command,
  [...cliCommand.args, ...process.argv.slice(2)],
  {
    input: await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  },
);

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exit(result.status ?? 0);
