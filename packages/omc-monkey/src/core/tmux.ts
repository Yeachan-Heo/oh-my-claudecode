import { spawnSync } from 'node:child_process';
import { logger } from '../utils/logger.js';

const SESSION_PREFIX = 'monkey-';

export interface TmuxSession {
  name: string;
  windows: number;
  created: Date;
  attached: boolean;
}

function checkTmuxInstalled(): void {
  const result = spawnSync('which', ['tmux'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error('tmux is not installed. Please install tmux to use omc-monkey.');
  }
}

export function createSession(sessionId: string, cwd: string): string {
  checkTmuxInstalled();

  const name = `${SESSION_PREFIX}${sessionId}`;

  const result = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to create tmux session: ${result.stderr || 'Unknown error'}`);
  }

  logger.info('Created tmux session', { name, cwd });
  return name;
}

export function killSession(name: string): void {
  checkTmuxInstalled();

  const result = spawnSync('tmux', ['kill-session', '-t', name], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    // Session might already be dead
    logger.warn('Failed to kill tmux session', { name, error: result.stderr });
  } else {
    logger.info('Killed tmux session', { name });
  }
}

export function sendKeys(name: string, text: string): void {
  checkTmuxInstalled();

  // Use -l (literal) flag to prevent tmux from interpreting special characters
  // This is CRITICAL for security - prevents command injection via backticks, $(), etc.
  const textResult = spawnSync('tmux', ['send-keys', '-t', name, '-l', text], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (textResult.status !== 0) {
    throw new Error(`Failed to send keys to tmux session: ${textResult.stderr || 'Unknown error'}`);
  }

  // Send Enter key separately (Enter is a tmux key name, not literal text)
  const enterResult = spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (enterResult.status !== 0) {
    throw new Error(`Failed to send Enter to tmux session: ${enterResult.stderr || 'Unknown error'}`);
  }
}

export function sendInterrupt(name: string): void {
  checkTmuxInstalled();

  const result = spawnSync('tmux', ['send-keys', '-t', name, 'C-c'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    logger.warn('Failed to send interrupt to tmux session', { name, error: result.stderr });
  }
}

export function capturePane(name: string, lines: number = 100): string {
  checkTmuxInstalled();

  try {
    const result = spawnSync('tmux', ['capture-pane', '-t', name, '-p', '-S', `-${lines}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      logger.error('Failed to capture tmux pane', { name, error: result.stderr });
      return '';
    }
    return result.stdout;
  } catch {
    return '';
  }
}

export function hasSession(name: string): boolean {
  checkTmuxInstalled();

  const result = spawnSync('tmux', ['has-session', '-t', name], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return result.status === 0;
}

export function listSessions(): TmuxSession[] {
  checkTmuxInstalled();

  try {
    const result = spawnSync('tmux', [
      'list-sessions', '-F',
      '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    if (result.status !== 0) return [];

    return result.stdout
      .trim()
      .split('\n')
      .filter(line => line.startsWith(SESSION_PREFIX))
      .map(line => {
        const [name, windows, created, attached] = line.split('|');
        return {
          name,
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000),
          attached: attached === '1',
        };
      });
  } catch {
    // No sessions or tmux not running
    return [];
  }
}

export function getSessionName(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

export function extractSessionId(tmuxName: string): string | null {
  if (!tmuxName.startsWith(SESSION_PREFIX)) return null;
  return tmuxName.slice(SESSION_PREFIX.length);
}
