import { spawn } from 'child_process';

export interface TokscaleLaunchOptions {
  view?: 'overview' | 'models' | 'daily' | 'stats';
  claude?: boolean; // Default true for OMC
}

/**
 * Check if tokscale CLI is available via bunx
 */
export async function isTokscaleCLIAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('bunx', ['tokscale@latest', '--version'], {
      stdio: 'ignore'
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}

/**
 * Launch tokscale interactive TUI
 *
 * tokscale subcommands:
 * - tui: default interactive view
 * - models: model breakdown view (also launches TUI)
 * - monthly: monthly report view (also launches TUI)
 *
 * Note: 'daily' and 'stats' views are not supported by tokscale,
 * so we fall back to 'tui' for those.
 */
export async function launchTokscaleTUI(options: TokscaleLaunchOptions = {}): Promise<void> {
  // Map view to tokscale subcommand
  const subcommand = options.view === 'models' ? 'models'
    : options.view === 'daily' ? 'monthly'  // tokscale has 'monthly', not 'daily'
    : 'tui';  // 'overview' and 'stats' use default tui

  const args = ['tokscale@latest', subcommand];

  // Always use --claude flag for OMC (Claude-focused) unless explicitly disabled
  if (options.claude !== false) {
    args.push('--claude');
  }

  const proc = spawn('bunx', args, {
    stdio: 'inherit'
  });

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tokscale exited with code ${code}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to launch tokscale: ${err.message}`));
    });
  });
}

/**
 * Get installation instructions for tokscale
 */
export function getInstallInstructions(): string {
  return `
To use the interactive TUI, install tokscale:

  bun install -g tokscale
  # or
  bunx tokscale@latest

Learn more: https://github.com/junhoyeo/tokscale
`;
}
