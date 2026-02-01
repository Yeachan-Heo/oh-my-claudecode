import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getStateDir(): string {
  return join(homedir(), '.omc', 'state');
}

function getLogsDir(): string {
  return join(homedir(), '.omc', 'logs');
}

function getPidPath(): string {
  return join(getStateDir(), 'clawdcoder.pid');
}

function getSocketPath(): string {
  return join(getStateDir(), 'clawdcoder.sock');
}

function getLogPath(): string {
  return join(getLogsDir(), 'clawdcoder.log');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleFiles(): void {
  const pidPath = getPidPath();
  const socketPath = getSocketPath();

  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (!isProcessRunning(pid)) {
      unlinkSync(pidPath);
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    }
  }
}

async function startBot(): Promise<void> {
  cleanupStaleFiles();

  const pidPath = getPidPath();

  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(chalk.yellow('ClawdCoder is already running.'));
      console.log(chalk.gray(`PID: ${pid}`));
      return;
    }
  }

  // Ensure directories exist
  const stateDir = getStateDir();
  const logsDir = getLogsDir();

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  // Path to the bundled bot
  const botPath = join(__dirname, '../../../bridge/clawdcoder.cjs');

  if (!existsSync(botPath)) {
    console.log(chalk.red('ClawdCoder bundle not found.'));
    console.log(chalk.gray(`Expected at: ${botPath}`));
    console.log(chalk.gray('Run "npm run build" to build the bundle.'));
    process.exit(1);
  }

  // Open log file for stdout/stderr
  const logPath = getLogPath();
  const logFd = openSync(logPath, 'a');

  // Spawn the bot as a detached process
  const child = spawn('node', [botPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: homedir(),
  });

  child.unref();

  // Write PID file
  writeFileSync(pidPath, String(child.pid));

  console.log(chalk.green('ClawdCoder started successfully!'));
  console.log(chalk.gray(`PID: ${child.pid}`));
  console.log(chalk.gray(`Log: ${logPath}`));
  console.log('');
  console.log(chalk.blue('Next steps:'));
  console.log('  - Check status: omc clawdcoder status');
  console.log('  - View logs: omc clawdcoder logs');
  console.log('  - Stop bot: omc clawdcoder stop');
}

async function stopBot(): Promise<void> {
  const pidPath = getPidPath();

  if (!existsSync(pidPath)) {
    console.log(chalk.yellow('ClawdCoder is not running.'));
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);

  if (!isProcessRunning(pid)) {
    console.log(chalk.yellow('ClawdCoder process not found (cleaning up stale files).'));
    cleanupStaleFiles();
    return;
  }

  // Send SIGTERM for graceful shutdown
  console.log(chalk.blue('Stopping ClawdCoder...'));
  process.kill(pid, 'SIGTERM');

  // Wait for process to exit (up to 10 seconds)
  let waited = 0;
  while (waited < 10000 && isProcessRunning(pid)) {
    await new Promise(resolve => setTimeout(resolve, 500));
    waited += 500;
  }

  if (isProcessRunning(pid)) {
    console.log(chalk.yellow('Process did not exit gracefully, sending SIGKILL...'));
    process.kill(pid, 'SIGKILL');
  }

  // Clean up files
  cleanupStaleFiles();

  console.log(chalk.green('ClawdCoder stopped.'));
}

async function showStatus(): Promise<void> {
  const pidPath = getPidPath();
  const socketPath = getSocketPath();

  console.log(chalk.blue.bold('ClawdCoder Status'));
  console.log(chalk.gray('─'.repeat(40)));

  if (!existsSync(pidPath)) {
    console.log(chalk.red('Status: Not running'));
    console.log('');
    console.log(chalk.gray('Start with: omc clawdcoder start'));
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);

  if (!isProcessRunning(pid)) {
    console.log(chalk.yellow('Status: Stale (process not found)'));
    console.log(chalk.gray(`Stale PID: ${pid}`));
    console.log('');
    console.log(chalk.gray('Clean up and restart: omc clawdcoder start'));
    return;
  }

  console.log(chalk.green('Status: Running'));
  console.log(chalk.gray(`PID: ${pid}`));
  console.log(chalk.gray(`Socket: ${existsSync(socketPath) ? 'Available' : 'Not available'}`));

  // Try to get detailed status via IPC
  if (existsSync(socketPath)) {
    try {
      const { connect } = await import('node:net');

      const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = connect(socketPath);
        let response = '';

        client.on('connect', () => {
          const request = JSON.stringify({
            jsonrpc: '2.0',
            method: 'status',
            id: 1,
          });
          client.write(request + '\n');
        });

        client.on('data', (data) => {
          response += data.toString();
          if (response.includes('\n')) {
            try {
              const parsed = JSON.parse(response.trim());
              resolve(parsed.result || {});
            } catch {
              reject(new Error('Invalid response'));
            }
            client.end();
          }
        });

        client.on('error', reject);
        client.setTimeout(5000);
      });

      console.log('');
      console.log(chalk.blue('Bot Details:'));

      if (status.activeSessions !== undefined) {
        console.log(`  Sessions: ${status.activeSessions}/${status.maxSessions || 5}`);
      }
      if (status.uptime !== undefined) {
        const uptimeSeconds = Math.floor((status.uptime as number) / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        console.log(`  Uptime: ${hours}h ${minutes}m`);
      }
      if (status.discordConnected !== undefined) {
        console.log(`  Discord: ${status.discordConnected ? chalk.green('Connected') : chalk.red('Disconnected')}`);
      }
      if (status.telegramConnected !== undefined) {
        console.log(`  Telegram: ${status.telegramConnected ? chalk.green('Connected') : chalk.red('Disconnected')}`);
      }
    } catch {
      console.log(chalk.yellow('  (Could not fetch detailed status)'));
    }
  }
}

async function tailLogs(): Promise<void> {
  const logPath = getLogPath();

  if (!existsSync(logPath)) {
    console.log(chalk.yellow('No log file found.'));
    console.log(chalk.gray(`Expected at: ${logPath}`));
    return;
  }

  console.log(chalk.blue(`Tailing ${logPath}`));
  console.log(chalk.gray('Press Ctrl+C to stop'));
  console.log(chalk.gray('─'.repeat(40)));

  // Use tail -f
  const { spawn } = await import('node:child_process');
  const tail = spawn('tail', ['-f', '-n', '50', logPath], {
    stdio: 'inherit',
  });

  process.on('SIGINT', () => {
    tail.kill();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    tail.on('close', () => resolve());
  });
}

export function clawdcoderCommand(cmd: Command): void {
  cmd
    .command('start')
    .description('Start the ClawdCoder bot')
    .action(startBot);

  cmd
    .command('stop')
    .description('Stop the ClawdCoder bot')
    .action(stopBot);

  cmd
    .command('status')
    .description('Show ClawdCoder status')
    .action(showStatus);

  cmd
    .command('logs')
    .description('Tail ClawdCoder logs')
    .action(tailLogs);

  cmd
    .command('restart')
    .description('Restart the ClawdCoder bot')
    .action(async () => {
      await stopBot();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await startBot();
    });
}
