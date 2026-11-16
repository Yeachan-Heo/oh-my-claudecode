#!/usr/bin/env node
'use strict';
// apiKeyHelper for provider sessions: prints the provider API key on stdout and nothing else.
// The key comes from the profile's apiKey source (file, env or command). For tests, the
// OMC_PROVIDER_API_KEY_FILE variable is read only together with a loopback OMC_PROVIDER_BASE_URL
// (the pair rule of the profile loader). Errors go to stderr without the key
// and without any path. Exit codes: 0 key printed, 1 no usable key, 2 bad configuration.
//
//   provider-key-helper.cjs --profile <name> [--file <profiles file>]

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { loadProfile, testBaseUrl, ProfileError, expandHome } = require('./lib/profile.cjs');

const COMMAND_TIMEOUT_MS = 10000;

// Rules: surrounding whitespace is dropped, an empty result or whitespace inside the key is an error.
function clean(text) {
  const key = String(text ?? '').trim();
  if (!key) return { error: 'the key is empty' };
  if (/\s/.test(key)) return { error: 'the key contains whitespace' };
  return { key };
}

function readSource(source, env) {
  if (source.file) {
    try {
      return clean(readFileSync(expandHome(source.file), 'utf8'));
    } catch {
      return { error: 'the key file cannot be read' };
    }
  }
  if (source.env) return clean(env[source.env]);
  if (source.command) {
    const run = spawnSync(expandHome(source.command), [], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (run.error || run.status !== 0) return { error: 'the key command failed' };
    return clean(run.stdout);
  }
  return { error: 'the profile has no key source' };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--profile' || argv[i] === '--file') && typeof argv[i + 1] === 'string') {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      throw new ProfileError('config', `unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function main(argv, env) {
  let source;
  try {
    const args = parseArgs(argv);
    const override = typeof env.OMC_PROVIDER_API_KEY_FILE === 'string' && env.OMC_PROVIDER_API_KEY_FILE.trim() !== '';
    if (override) {
      // Test-only key file: allowed only together with a loopback base URL (same pair rule as the profile loader).
      testBaseUrl(env);
      source = { file: env.OMC_PROVIDER_API_KEY_FILE };
    } else {
      source = loadProfile(env, { name: args.profile, file: args.file }).profile.apiKey;
    }
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    process.stderr.write(`provider-key-helper: ${error.message}\n`);
    return error.exit;
  }
  const result = readSource(source, env);
  if (result.error) {
    process.stderr.write(`provider-key-helper: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(result.key);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}

module.exports = { clean, readSource, main };
