/**
 * OpenClaw MCP Core - Integration with OpenClaw AI agent runtime
 *
 * OpenClaw is a personal AI assistant runtime with multi-agent orchestration,
 * cron scheduling, browser control, and messaging integrations.
 *
 * This module enables OMC to leverage OpenClaw's 24/7 agent capabilities:
 * - Spawn sub-agents via sessions_spawn
 * - Persistent memory across sessions
 * - Messaging integrations (WhatsApp, Telegram, Discord)
 * - Browser automation
 *
 * @see https://github.com/openclaw/openclaw
 * @see https://docs.openclaw.ai
 */
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
// Default configuration
export const OPENCLAW_DEFAULT_MODEL = process.env.OMC_OPENCLAW_DEFAULT_MODEL || 'anthropic/claude-sonnet-4-5';
export const OPENCLAW_TIMEOUT = parseInt(process.env.OMC_OPENCLAW_TIMEOUT || '300000', 10);
// OpenClaw CLI detection
let openclawCliPath = null;
let detectionAttempted = false;
/**
 * Detect if OpenClaw CLI is installed and available
 */
export function detectOpenclawCli() {
    if (detectionAttempted) {
        return openclawCliPath;
    }
    detectionAttempted = true;
    try {
        // Try to find openclaw in PATH
        const result = execSync('which openclaw 2>/dev/null || where openclaw 2>nul', {
            encoding: 'utf-8',
            timeout: 5000
        }).trim();
        if (result) {
            openclawCliPath = result.split('\n')[0].trim();
            console.log(`[openclaw-core] Found OpenClaw CLI at: ${openclawCliPath}`);
            return openclawCliPath;
        }
    }
    catch {
        // CLI not found
    }
    // Try common installation paths
    const commonPaths = [
        '/usr/local/bin/openclaw',
        '/home/claw/.npm-global/bin/openclaw',
        process.env.HOME ? join(process.env.HOME, '.npm-global/bin/openclaw') : null,
    ].filter(Boolean);
    for (const path of commonPaths) {
        if (existsSync(path)) {
            openclawCliPath = path;
            console.log(`[openclaw-core] Found OpenClaw CLI at: ${openclawCliPath}`);
            return openclawCliPath;
        }
    }
    console.log('[openclaw-core] OpenClaw CLI not found');
    return null;
}
/**
 * Check if OpenClaw gateway is running
 */
export async function isGatewayRunning() {
    try {
        const cli = detectOpenclawCli();
        if (!cli)
            return false;
        const result = execSync(`${cli} status 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 5000
        });
        return result.includes('running') || result.includes('connected');
    }
    catch {
        return false;
    }
}
/**
 * Spawn a sub-agent task via OpenClaw
 *
 * This uses OpenClaw's sessions_spawn to run a task in an isolated session,
 * returning results when complete.
 */
export async function spawnOpenclawAgent(options) {
    const cli = detectOpenclawCli();
    if (!cli) {
        return {
            success: false,
            error: 'OpenClaw CLI not found. Install with: npm install -g openclaw'
        };
    }
    const model = options.model || OPENCLAW_DEFAULT_MODEL;
    const timeout = options.timeoutSeconds || Math.floor(OPENCLAW_TIMEOUT / 1000);
    return new Promise((resolve) => {
        const args = [
            'sessions', 'spawn',
            '--task', options.task,
            '--model', model,
            '--timeout', timeout.toString(),
        ];
        if (options.label) {
            args.push('--label', options.label);
        }
        if (options.agentId) {
            args.push('--agent-id', options.agentId);
        }
        const child = spawn(cli, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: OPENCLAW_TIMEOUT
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0) {
                try {
                    const result = JSON.parse(stdout);
                    resolve({
                        success: true,
                        result: result.output || result.message || stdout,
                        sessionKey: result.sessionKey
                    });
                }
                catch {
                    resolve({
                        success: true,
                        result: stdout.trim()
                    });
                }
            }
            else {
                resolve({
                    success: false,
                    error: stderr || `Process exited with code ${code}`
                });
            }
        });
        child.on('error', (err) => {
            resolve({
                success: false,
                error: err.message
            });
        });
    });
}
/**
 * Send a message to an existing OpenClaw session
 */
export async function sendToSession(sessionKey, message) {
    const cli = detectOpenclawCli();
    if (!cli) {
        return {
            success: false,
            error: 'OpenClaw CLI not found'
        };
    }
    return new Promise((resolve) => {
        const child = spawn(cli, [
            'sessions', 'send',
            '--session-key', sessionKey,
            '--message', message
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60000
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, result: stdout.trim() });
            }
            else {
                resolve({ success: false, error: stderr || stdout });
            }
        });
        child.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}
/**
 * Get OpenClaw system info for diagnostics
 */
export function getOpenclawInfo() {
    const cli = detectOpenclawCli();
    let version = null;
    if (cli) {
        try {
            version = execSync(`${cli} --version 2>/dev/null`, {
                encoding: 'utf-8',
                timeout: 5000
            }).trim();
        }
        catch {
            // Version check failed
        }
    }
    return {
        installed: cli !== null,
        cliPath: cli,
        version
    };
}
//# sourceMappingURL=openclaw-core.js.map