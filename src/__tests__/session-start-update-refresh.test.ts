import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as TcpServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;
/** Closed port: connections are refused immediately, so fetch fails offline. */
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9';

/**
 * The no-workspace SessionStart path must answer immediately: the registry
 * refresh is handed to a detached child, so a stalled registry can never add
 * to launch latency. Everything here is local; no test touches the network.
 */
describe('session-start.mjs detached update-cache refresh', () => {
  let tempDir: string;
  let fakeHome: string;
  let configDir: string;
  let cachePath: string;
  let nonWorkspace: string;
  let hangingServer: TcpServer | null = null;
  let fakeRegistry: HttpServer | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-update-refresh-'));
    fakeHome = join(tempDir, 'home');
    configDir = join(fakeHome, '.claude');
    cachePath = join(configDir, '.omc', 'update-check.json');
    nonWorkspace = join(tempDir, 'not-a-workspace');
    mkdirSync(nonWorkspace, { recursive: true });
    mkdirSync(join(configDir, '.omc'), { recursive: true });
    // Stale timestamps: both checks would fetch if they were reached.
    writeFileSync(
      cachePath,
      JSON.stringify({
        timestamp: 0,
        latestVersion: '1.0.0',
        currentVersion: '1.0.0',
        updateAvailable: false,
        source: 'npm',
      }),
    );
  });

  afterEach(() => {
    hangingServer?.close();
    hangingServer = null;
    fakeRegistry?.close();
    fakeRegistry = null;
    // The detached child may still hold files briefly; retry the cleanup.
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function baseEnv(registryBase: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // config-dir.mjs prefers CLAUDE_CONFIG_DIR over HOME.
      CLAUDE_CONFIG_DIR: configDir,
      OMC_UPDATE_REGISTRY_BASE: registryBase,
      CLAUDE_PLUGIN_ROOT: '',
    };
  }

  /** A TCP server that accepts and never replies, so fetch stalls until abort. */
  async function startHangingRegistry(): Promise<string> {
    const server = createTcpServer(() => {
      /* accept the socket and never respond */
    });
    hangingServer = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  /** A local registry that answers the /latest requests both checks make. */
  async function startFakeRegistry(version: string): Promise<string> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version }));
    });
    fakeRegistry = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  function runHook(registryBase: string) {
    const started = Date.now();
    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'refresh', cwd: nonWorkspace }),
      encoding: 'utf-8',
      env: baseEnv(registryBase),
      timeout: 15000,
    });
    return { ...result, elapsedMs: Date.now() - started };
  }

  /**
   * Run the script without blocking this process: spawnSync would freeze the
   * event loop, so the local fake registry could never answer the child.
   */
  function runScriptAsync(args: string[], registryBase: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(NODE, [SCRIPT_PATH, ...args], {
        stdio: 'ignore',
        env: baseEnv(registryBase),
      });
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
  }

  function parseResponses(stdout: string): unknown[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  it('emits exactly one response and returns before the fetch timeout', async () => {
    const registryBase = await startHangingRegistry();
    const result = runHook(registryBase);

    const responses = parseResponses(result.stdout);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ continue: true });
    expect(result.status).toBe(0);
    // The registry never answers; a blocking check would cost at least 2s.
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it('emits exactly once and leaves a well-formed cache when the registry is unreachable', () => {
    const result = runHook(UNREACHABLE_REGISTRY);

    const responses = parseResponses(result.stdout);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ continue: true });
    expect(result.status).toBe(0);

    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    expect(cached.latestVersion).toBe('1.0.0');
  });

  it('writes no workspace or session state on the no-workspace path', () => {
    const result = runHook(UNREACHABLE_REGISTRY);
    expect(result.status).toBe(0);

    expect(existsSync(join(nonWorkspace, '.omc'))).toBe(false);
    expect(readdirSync(nonWorkspace)).toEqual([]);
    expect(existsSync(join(configDir, '.omc', 'state'))).toBe(false);
    expect(existsSync(join(configDir, '.omc', 'sessions'))).toBe(false);
  });

  describe('--refresh-update-cache child mode', () => {
    it('merges the fetched version into the cache and exits within its deadline', async () => {
      const registryBase = await startFakeRegistry('9.9.9');
      const started = Date.now();

      const status = await runScriptAsync(['--refresh-update-cache'], registryBase);

      expect(status).toBe(0);
      expect(Date.now() - started).toBeLessThan(10000);

      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
      expect(cached.claudeCodeLatestVersion).toBe('9.9.9');
      // The pre-existing OMC fields survive the merge.
      expect(cached.currentVersion).toBe('1.0.0');
    });

    it('exits cleanly without throwing when the registry is unreachable', () => {
      const result = spawnSync(NODE, [SCRIPT_PATH, '--refresh-update-cache'], {
        encoding: 'utf-8',
        env: baseEnv(UNREACHABLE_REGISTRY),
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
      expect(cached.latestVersion).toBe('1.0.0');
      expect(cached.claudeCodeLatestVersion).toBeUndefined();
    });

    it('serializes concurrent refreshes and leaves a complete cache document', async () => {
      const registryBase = await startFakeRegistry('9.9.9');
      const statuses = await Promise.all(
        Array.from({ length: 8 }, () => runScriptAsync(['--refresh-update-cache'], registryBase)),
      );

      expect(statuses).toEqual(Array(8).fill(0));
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
      expect(cached.latestVersion).toBe('1.0.0');
      expect(cached.claudeCodeLatestVersion).toBe('9.9.9');
      expect(cached.claudeCodeCheckedAt).toBeTypeOf('number');
    });
  });
});
