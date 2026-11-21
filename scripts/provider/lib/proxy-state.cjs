'use strict';
// Client side of the local provider proxy: finds the state directory, applies the liveness
// rule to the recorded pid and port, and tells session starters which base URL and which
// token to hand to a tool. Nothing here starts, stops or talks to the server except the
// optional health probe. The state files are written by provider-proxy.mjs.
//
// Liveness rule: proxy.pid and proxy.port hold valid integers (pid at least 2, port 1 to
// 65535), a signal 0 to the pid succeeds (EPERM counts as alive) and, where /proc exists,
// the command line of that pid carries the proxy marker tokens. A live process without the
// marker means a recycled pid, which is not the proxy.

const { readFileSync } = require('node:fs');
const http = require('node:http');
const { join, resolve } = require('node:path');
const { statePath, testBaseUrl } = require('./profile.cjs');

// Tokens that the server process carries in its command line (script name and sub-command).
const PROXY_MARKER = Object.freeze(['provider-proxy', '_serve']);
// Credential handed to clients when the proxy does not require a client token.
const PROXY_PLACEHOLDER_TOKEN = 'provider-proxy-placeholder';
const LOOPBACK = '127.0.0.1';

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function proxyDir(profile, env = process.env) {
  const explicit = nonEmpty(env.OMC_PROVIDER_PROXY_DIR);
  if (explicit) return resolve(explicit);
  return statePath(profile, env, 'proxy');
}

function readInteger(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
  } catch {
    return NaN;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

// Recorded state of the server, or null when the pid or port file is missing or invalid.
// Only the files are read; nothing is checked about the process.
function readProxyState(dir) {
  const pid = readInteger(join(dir, 'proxy.pid'));
  const port = readInteger(join(dir, 'proxy.port'));
  if (!Number.isInteger(pid) || pid < 2 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { pid, port, target: readText(join(dir, 'proxy.target')) };
}

function procFsAvailable() {
  try {
    readFileSync('/proc/self/cmdline');
    return true;
  } catch {
    return false;
  }
}

function hasMarker(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return PROXY_MARKER.every((token) => cmdline.includes(token));
  } catch {
    return false;
  }
}

// True when the state points at a running proxy process. Synchronous: without /proc the
// marker cannot be checked here, so the signal probe decides (isLiveVerified adds a health probe).
function isLive(state) {
  if (!state) return false;
  const { pid, port } = state;
  if (!Number.isInteger(pid) || pid < 2 || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!error || error.code !== 'EPERM') return false;
  }
  return procFsAvailable() ? hasMarker(pid) : true;
}

// GET /health on the loopback port; resolves to the parsed document or null.
function probeHealth(port, timeoutMs = 1000) {
  return new Promise((done) => {
    const req = http.request({ host: LOOPBACK, port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try {
          done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          done(null);
        }
      });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end();
  });
}

// Like isLive, and on platforms without /proc a successful health probe is required.
async function isLiveVerified(state) {
  if (!isLive(state)) return false;
  if (procFsAvailable()) return true;
  return (await probeHealth(state.port)) !== null;
}

// Base URL and token for a running proxy of this state directory, or null.
function readClient(dir) {
  const state = readProxyState(dir);
  if (!isLive(state)) return null;
  const token = readText(join(dir, 'client-token'));
  return {
    baseUrl: `http://${LOOPBACK}:${state.port}`,
    token: token || PROXY_PLACEHOLDER_TOKEN,
    pid: state.pid,
    port: state.port,
  };
}

// Where a tool should send its requests: the test pair wins, then a running proxy, then the
// provider itself. clientToken is set only when the proxy is used; with no running proxy the
// caller keeps the normal key path.
function resolveEndpoint(profile, env = process.env) {
  const testUrl = testBaseUrl(env);
  if (testUrl) return { baseUrl: testUrl, viaProxy: false, clientToken: null };
  const client = readClient(proxyDir(profile, env));
  if (client) return { baseUrl: client.baseUrl, viaProxy: true, clientToken: client.token };
  return { baseUrl: profile.baseUrl, viaProxy: false, clientToken: null };
}

module.exports = {
  PROXY_MARKER,
  PROXY_PLACEHOLDER_TOKEN,
  proxyDir,
  readProxyState,
  isLive,
  isLiveVerified,
  probeHealth,
  readClient,
  resolveEndpoint,
};
