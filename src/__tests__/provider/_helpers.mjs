/* global process, Buffer, setTimeout */
// Shared fixtures for the provider tests. Nothing here touches the network except
// loopback servers started on 127.0.0.1 with an ephemeral port.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const PLACEHOLDER_KEY = 'FAKE-KEY-0123456789';

// Temporary directory under os.tmpdir(). cleanup() removes only this directory.
export function makeTmp(prefix = 'provider-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const cleanup = () => {
    const root = resolve(tmpdir());
    const target = resolve(dir);
    if (!target.startsWith(root + sep) || !target.slice(root.length + 1).startsWith(prefix)) {
      throw new Error('refusing to remove a directory outside the test temp root');
    }
    rmSync(target, { recursive: true, force: true });
  };
  return { dir, home, cleanup };
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
    out[key] = plain && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

// Writes a fixture profiles file with the placeholder provider "acme" and returns its env.
// tuned: true adds non-default values (16 session slots, worker model haiku and effort max, thresholds 96/99).
export function writeProfile(dir, overrides = {}, { tuned = false } = {}) {
  const keyFile = fakeKeyFile(dir);
  const profile = {
    baseUrl: 'https://llm.acme.example/anthropic',
    apiKey: { file: keyFile },
    shimNames: [],
    stateDir: join(dir, 'state'),
    models: {
      opus: { id: 'acme-large[1m]' },
      sonnet: { id: 'acme-large[1m]' },
      haiku: { id: 'acme-small[1m]' },
      default: 'sonnet',
    },
    modelIdPrefixes: ['acme-'],
    roles: ['executor'],
    limits: { maxSessions: 6 },
  };
  if (tuned) {
    profile.limits = { maxSessions: 16 };
    profile.worker = { model: 'haiku', effort: 'max' };
    profile.quota = { thresholds: { pause: 96, stop: 99, weeklyAsWindow: true } };
  }
  const merged = deepMerge(profile, overrides);
  if (overrides.apiKey) merged.apiKey = overrides.apiKey; // a key source replaces the whole object
  const file = join(dir, 'providers.jsonc');
  const doc = { defaultProfile: 'acme', profiles: { acme: merged } };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), OMC_PROVIDER_PROFILES_FILE: file };
  return { file, profile: merged, env };
}

// Writes a key file (mode 0600) and returns its path.
export function fakeKeyFile(dir, content = PLACEHOLDER_KEY) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'fake.key');
  writeFileSync(file, `${content}\n`, { mode: 0o600 });
  return file;
}

// Fake `claude` binary: records argv (JSON) to $HOME/fake.argv and variable names to
// $HOME/fake.env, then exits with FAKE_EXIT from its environment or the exit option.
export function fakeClaude(dir, { exit = 0 } = {}) {
  const file = join(dir, 'fake-claude');
  const body = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const home = process.env.HOME;",
    'fs.writeFileSync(home + "/fake.argv", JSON.stringify(process.argv.slice(2)));',
    'fs.writeFileSync(home + "/fake.env", JSON.stringify(Object.keys(process.env).sort()));',
    `process.exit(Number(process.env.FAKE_EXIT ?? ${Number(exit)}));`,
    '',
  ].join('\n');
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

export function runNode(script, args = [], { env = {}, input, cwd, timeoutMs = 20000 } = {}) {
  const run = spawnSync(process.execPath, [script, ...args], {
    env,
    input,
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return { status: run.status, signal: run.signal, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

// Provider stub on 127.0.0.1:0. Each request takes the next scenario entry (the last one repeats).
// Entry: { status, headers, body, delayMs, sse }. Responses are recorded in `requests`.
export function fakeProvider(scenario = [{ status: 200, body: '{}' }]) {
  const requests = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const step = scenario[Math.min(index, scenario.length - 1)];
      index++;
      const send = () => {
        const headers = { 'content-type': step.sse ? 'text/event-stream' : 'application/json', ...(step.headers ?? {}) };
        res.writeHead(step.status ?? 200, headers);
        res.end(step.body ?? '');
      };
      if (step.delayMs) setTimeout(send, step.delayMs);
      else send();
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Quota endpoint stub: answers every request with the given limits (data.limits[] format).
export function fakeQuotaServer(limits = []) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: 'Operation successful', success: true, data: { limits } }));
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Long-running process whose command line carries the proxy marker tokens, for client tests.
export function stubProxyProcess(dir) {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'provider-proxy.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script, '_serve'], { stdio: 'ignore' });
  return {
    pid: child.pid,
    stop: () => new Promise((done) => {
      child.once('exit', () => done());
      child.kill('SIGTERM');
    }),
  };
}

// Reads a JSON or text file written by a fixture; returns null when it is missing.
export function readFixture(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

