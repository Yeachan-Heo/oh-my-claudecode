/**
 * Wait Command
 *
 * CLI commands for rate limit wait and auto-resume functionality.
 *
 * Design Philosophy (aligned with oh-my-claudecode values):
 * - Zero learning curve: `omc wait` just works
 * - Smart defaults: Auto-detects tmux and daemon status
 * - Minimal commands: Most users only need `omc wait`
 *
 * Commands:
 *   omc wait               - Smart command: shows status, offers to start daemon if needed
 *   omc wait status        - Show current rate limit and daemon status
 *   omc wait daemon start  - Start the background daemon
 *   omc wait daemon stop   - Stop the daemon
 *   omc wait detect        - Scan for blocked Claude Code sessions
 */
import chalk from 'chalk';
import { checkRateLimitStatus, formatRateLimitStatus, isTmuxAvailable, isInsideTmux, getDaemonStatus, startDaemon, stopDaemon, detectBlockedPanes, runDaemonForeground, isDaemonRunning, } from '../../features/rate-limit-wait/index.js';
/**
 * Smart wait command - the main entry point
 * Follows "zero learning curve" philosophy
 */
export async function waitCommand(options) {
    // Handle explicit start/stop flags
    if (options.start) {
        await waitDaemonCommand('start', {});
        return;
    }
    if (options.stop) {
        await waitDaemonCommand('stop', {});
        return;
    }
    const rateLimitStatus = await checkRateLimitStatus();
    const daemonRunning = isDaemonRunning();
    const tmuxAvailable = isTmuxAvailable();
    if (options.json) {
        console.log(JSON.stringify({
            rateLimit: rateLimitStatus,
            daemon: { running: daemonRunning },
            tmux: { available: tmuxAvailable, insideSession: isInsideTmux() },
        }, null, 2));
        return;
    }
    // Smart output based on current state
    console.log(chalk.bold('\n🕐 Rate Limit Status\n'));
    if (!rateLimitStatus) {
        console.log(chalk.yellow('Unable to check rate limits (OAuth credentials required)\n'));
        console.log(chalk.gray('Rate limit monitoring requires Claude Pro/Max subscription.'));
        return;
    }
    if (rateLimitStatus.isLimited) {
        // Rate limited - provide helpful guidance
        console.log(chalk.red.bold('⚠️  Rate Limited'));
        console.log(chalk.yellow(`\n${formatRateLimitStatus(rateLimitStatus)}\n`));
        if (!tmuxAvailable) {
            console.log(chalk.gray('💡 Install tmux to enable auto-resume when limit clears'));
            console.log(chalk.gray('   brew install tmux  (macOS)'));
            console.log(chalk.gray('   apt install tmux   (Linux)\n'));
        }
        else if (!daemonRunning) {
            console.log(chalk.cyan('💡 Want to auto-resume when the limit clears?'));
            console.log(chalk.white('   Run: ') + chalk.green('omc wait --start'));
            console.log(chalk.gray('   (or: omc wait daemon start)\n'));
        }
        else {
            console.log(chalk.green('✓ Auto-resume daemon is running'));
            console.log(chalk.gray('  Your session will resume automatically when the limit clears.\n'));
        }
    }
    else {
        // Not rate limited
        console.log(chalk.green('✓ Not rate limited\n'));
        if (daemonRunning) {
            console.log(chalk.gray('Auto-resume daemon is running (not needed when not rate limited)'));
            console.log(chalk.gray('Stop with: omc wait --stop\n'));
        }
    }
}
/**
 * Show current rate limit and daemon status
 */
export async function waitStatusCommand(options) {
    const rateLimitStatus = await checkRateLimitStatus();
    const daemonStatus = getDaemonStatus();
    if (options.json) {
        console.log(JSON.stringify({
            rateLimit: rateLimitStatus,
            daemon: daemonStatus,
            tmux: {
                available: isTmuxAvailable(),
                insideSession: isInsideTmux(),
            },
        }, null, 2));
        return;
    }
    console.log(chalk.bold('\n📊 Rate Limit Wait Status\n'));
    console.log(chalk.gray('─'.repeat(50)));
    // Rate limit status
    console.log(chalk.bold('\nRate Limits:'));
    if (rateLimitStatus) {
        if (rateLimitStatus.isLimited) {
            console.log(chalk.yellow(`  ⚠ ${formatRateLimitStatus(rateLimitStatus)}`));
            if (rateLimitStatus.fiveHourLimited && rateLimitStatus.fiveHourResetsAt) {
                console.log(chalk.gray(`    5-hour resets: ${rateLimitStatus.fiveHourResetsAt.toLocaleString()}`));
            }
            if (rateLimitStatus.weeklyLimited && rateLimitStatus.weeklyResetsAt) {
                console.log(chalk.gray(`    Weekly resets: ${rateLimitStatus.weeklyResetsAt.toLocaleString()}`));
            }
        }
        else {
            console.log(chalk.green('  ✓ Not rate limited'));
            console.log(chalk.gray(`    5-hour: ${rateLimitStatus.fiveHourLimited ? '100%' : 'OK'}`));
            console.log(chalk.gray(`    Weekly: ${rateLimitStatus.weeklyLimited ? '100%' : 'OK'}`));
        }
        console.log(chalk.dim(`    Last checked: ${rateLimitStatus.lastCheckedAt.toLocaleTimeString()}`));
    }
    else {
        console.log(chalk.yellow('  ? Unable to check (no OAuth credentials?)'));
    }
    // Daemon status
    console.log(chalk.bold('\nDaemon:'));
    if (daemonStatus.state) {
        if (daemonStatus.state.isRunning) {
            console.log(chalk.green(`  ✓ Running (PID: ${daemonStatus.state.pid})`));
            if (daemonStatus.state.lastPollAt) {
                console.log(chalk.dim(`    Last poll: ${daemonStatus.state.lastPollAt.toLocaleTimeString()}`));
            }
            console.log(chalk.dim(`    Resume attempts: ${daemonStatus.state.totalResumeAttempts}`));
            console.log(chalk.dim(`    Successful: ${daemonStatus.state.successfulResumes}`));
        }
        else {
            console.log(chalk.gray('  ○ Not running'));
        }
    }
    else {
        console.log(chalk.gray('  ○ Never started'));
    }
    // tmux status
    console.log(chalk.bold('\ntmux:'));
    if (isTmuxAvailable()) {
        console.log(chalk.green('  ✓ Available'));
        if (isInsideTmux()) {
            console.log(chalk.dim('    Currently inside tmux session'));
        }
    }
    else {
        console.log(chalk.yellow('  ⚠ Not installed'));
        console.log(chalk.gray('    Install tmux for auto-resume functionality'));
    }
    console.log('');
}
/**
 * Start/stop the daemon
 */
export async function waitDaemonCommand(action, options) {
    const config = {
        verbose: options.verbose,
        pollIntervalMs: options.interval ? options.interval * 1000 : undefined,
    };
    if (action === 'start') {
        if (options.foreground) {
            // Run in foreground (blocking)
            await runDaemonForeground(config);
        }
        else {
            const result = startDaemon(config);
            if (result.success) {
                console.log(chalk.green(`✓ ${result.message}`));
                console.log(chalk.gray('\nThe daemon will:'));
                console.log(chalk.gray('  • Poll rate limit status every minute'));
                console.log(chalk.gray('  • Track blocked Claude Code sessions in tmux'));
                console.log(chalk.gray('  • Auto-resume sessions when rate limit clears'));
                console.log(chalk.gray('\nUse "omc wait status" to check daemon status'));
                console.log(chalk.gray('Use "omc wait daemon stop" to stop the daemon'));
            }
            else {
                console.error(chalk.red(`✗ ${result.message}`));
                if (result.error) {
                    console.error(chalk.gray(`  ${result.error}`));
                }
                process.exit(1);
            }
        }
    }
    else if (action === 'stop') {
        const result = stopDaemon(config);
        if (result.success) {
            console.log(chalk.green(`✓ ${result.message}`));
        }
        else {
            console.error(chalk.red(`✗ ${result.message}`));
            if (result.error) {
                console.error(chalk.gray(`  ${result.error}`));
            }
            process.exit(1);
        }
    }
}
/**
 * Detect blocked Claude Code sessions
 */
export async function waitDetectCommand(options) {
    if (!isTmuxAvailable()) {
        console.error(chalk.yellow('⚠ tmux is not installed'));
        console.log(chalk.gray('Install tmux to use session detection and auto-resume'));
        process.exit(1);
    }
    console.log(chalk.blue('Scanning for blocked Claude Code sessions...\n'));
    const config = {
        paneLinesToCapture: options.lines,
    };
    const result = await detectBlockedPanes(config);
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(result.message);
    if (result.state?.blockedPanes && result.state.blockedPanes.length > 0) {
        console.log(chalk.gray('\nTip: Start the daemon to auto-resume when rate limit clears:'));
        console.log(chalk.gray('  omc wait daemon start'));
    }
    // Also show rate limit status
    if (result.state?.rateLimitStatus) {
        console.log(chalk.bold('\nCurrent Rate Limit:'));
        console.log(`  ${formatRateLimitStatus(result.state.rateLimitStatus)}`);
    }
}
//# sourceMappingURL=wait.js.map