import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { getSocketPath } from '../config.js';
import { logger } from '../utils/logger.js';
import * as sessionManager from '../core/session-manager.js';
import { UserRepository } from '../db/repositories/users.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../types.js';

let server: Server | null = null;
const userRepo = new UserRepository();

// Get or create a system user for IPC requests
function getSystemUser() {
  return userRepo.findOrCreate({
    username: 'system',
    discordId: undefined,
    telegramId: undefined,
  });
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { method, params, id } = request;

  try {
    let result: unknown;

    switch (method) {
      case 'session.create': {
        const user = getSystemUser();
        const session = await sessionManager.createSession({
          name: params?.name as string,
          workingDirectory: params?.projectDir as string,
          user,
          initialPrompt: params?.prompt as string | undefined,
        });
        result = { sessionId: session.id, tmuxSession: session.tmuxSession };
        break;
      }

      case 'session.list': {
        const sessions = sessionManager.listActiveSessions();
        result = sessions.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          workingDirectory: s.workingDirectory,
          createdAt: s.createdAt.toISOString(),
        }));
        break;
      }

      case 'session.send': {
        const sessionId = params?.sessionId as string;
        const prompt = params?.prompt as string;

        // Try by name first, then by ID
        let session = sessionManager.getSessionByName(sessionId);
        if (!session) {
          session = sessionManager.getSession(sessionId);
        }

        if (!session) {
          throw new Error(`Session "${sessionId}" not found`);
        }

        const queuePosition = await sessionManager.sendPrompt(session.id, prompt);
        result = { queuePosition };
        break;
      }

      case 'session.output': {
        const sessionId = params?.sessionId as string;
        const lines = (params?.lines as number) ?? 100;

        let session = sessionManager.getSessionByName(sessionId);
        if (!session) {
          session = sessionManager.getSession(sessionId);
        }

        if (!session) {
          throw new Error(`Session "${sessionId}" not found`);
        }

        const output = sessionManager.getOutput(session.id, lines);
        result = { output };
        break;
      }

      case 'session.kill': {
        const sessionId = params?.sessionId as string;

        let session = sessionManager.getSessionByName(sessionId);
        if (!session) {
          session = sessionManager.getSession(sessionId);
        }

        if (!session) {
          throw new Error(`Session "${sessionId}" not found`);
        }

        sessionManager.killSession(session.id);
        result = { success: true };
        break;
      }

      case 'status': {
        result = sessionManager.getStatus();
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { jsonrpc: '2.0', result, id };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
      id,
    };
  }
}

function handleConnection(socket: Socket): void {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString();

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await handleRequest(request);
        socket.write(JSON.stringify(response) + '\n');
      } catch (error) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: 'Parse error',
          },
          id: null as unknown as number,
        };
        socket.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  });

  socket.on('error', (error) => {
    logger.error('IPC socket error', { error: String(error) });
  });
}

export function startIpcServer(): void {
  const socketPath = getSocketPath();

  // Clean up existing socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  server = createServer(handleConnection);

  server.on('error', (error) => {
    logger.error('IPC server error', { error: String(error) });
  });

  server.listen(socketPath, () => {
    // Set socket permissions to 0600 (owner only)
    chmodSync(socketPath, 0o600);
    logger.info('IPC server started', { socketPath });
  });
}

export function stopIpcServer(): void {
  if (server) {
    server.close();
    server = null;

    const socketPath = getSocketPath();
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    logger.info('IPC server stopped');
  }
}
