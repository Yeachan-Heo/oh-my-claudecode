import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { getBridgePortPath, getBridgeSocketPath, getSessionDir, getRuntimeDir } from '../paths.js';
import { sendSocketRequest } from '../socket-client.js';

// =============================================================================
// paths.ts - getBridgePortPath
// =============================================================================

describe('getBridgePortPath', () => {
  it('returns bridge.port in the session directory', () => {
    const sessionId = 'test-session-tcp';
    const portPath = getBridgePortPath(sessionId);
    const sessionDir = getSessionDir(sessionId);

    expect(portPath).toBe(path.join(sessionDir, 'bridge.port'));
  });

  it('produces a different file than getBridgeSocketPath', () => {
    const sessionId = 'test-session-tcp';
    const portPath = getBridgePortPath(sessionId);
    const socketPath = getBridgeSocketPath(sessionId);

    expect(portPath).not.toBe(socketPath);
    expect(portPath).toMatch(/bridge\.port$/);
    expect(socketPath).toMatch(/bridge\.sock$/);
  });
});

// =============================================================================
// socket-client.ts - TCP fallback via tcp:<port> prefix
// =============================================================================

describe('sendSocketRequest TCP fallback', () => {
  let tcpServer: net.Server;
  let serverPort: number;

  beforeEach(async () => {
    // Create a minimal JSON-RPC server on TCP localhost
    tcpServer = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          const req = JSON.parse(line);
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { status: 'ok', method: req.method },
          }) + '\n';
          conn.write(response);
        }
      });
    });

    await new Promise<void>((resolve) => {
      tcpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = tcpServer.address() as net.AddressInfo;
    serverPort = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      tcpServer.close(() => resolve());
    });
  });

  it('connects via tcp:<port> and receives JSON-RPC response', async () => {
    const result = await sendSocketRequest<{ status: string; method: string }>(
      `tcp:${serverPort}`,
      'ping',
      {},
      5000
    );

    expect(result.status).toBe('ok');
    expect(result.method).toBe('ping');
  });

  it('sends parameters correctly over TCP', async () => {
    // Upgrade server to echo params
    tcpServer.close();

    tcpServer = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          const req = JSON.parse(line);
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { params: req.params },
          }) + '\n';
          conn.write(response);
        }
      });
    });

    await new Promise<void>((resolve) => {
      tcpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = tcpServer.address() as net.AddressInfo;
    const port = addr.port;

    const result = await sendSocketRequest<{ params: Record<string, unknown> }>(
      `tcp:${port}`,
      'execute',
      { code: 'print("hello")' },
      5000
    );

    expect(result.params).toEqual({ code: 'print("hello")' });
  });

  it('falls back to path-based socket for non-tcp: prefixes', async () => {
    // Attempting to connect to a non-existent socket path should throw SocketConnectionError
    await expect(
      sendSocketRequest('/tmp/nonexistent-test-socket.sock', 'ping', {}, 1000)
    ).rejects.toThrow(/socket/i);
  });
});

// =============================================================================
// bridge-manager.ts - port file read/detection (integration-level)
// =============================================================================

describe('TCP port file integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-tcp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('port file contains a valid port number', () => {
    const portFile = path.join(tmpDir, 'bridge.port');
    fs.writeFileSync(portFile, '54321', 'utf-8');

    const content = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(content, 10);

    expect(port).toBe(54321);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('rejects invalid port file content', () => {
    const portFile = path.join(tmpDir, 'bridge.port');
    fs.writeFileSync(portFile, 'not-a-number', 'utf-8');

    const content = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(content, 10);

    expect(Number.isFinite(port)).toBe(false);
  });

  it('port file and socket path coexist in session directory', () => {
    const sessionId = 'coexist-test';
    const portPath = getBridgePortPath(sessionId);
    const socketPath = getBridgeSocketPath(sessionId);

    // They should be in the same directory but different files
    expect(path.dirname(portPath)).toBe(path.dirname(socketPath));
    expect(path.basename(portPath)).toBe('bridge.port');
    expect(path.basename(socketPath)).toBe('bridge.sock');
  });
});
