/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management
 */
export declare function prepareOmcLaunchConfigDir(baseConfigDir?: string): string;
/**
 * Extract the OMC-specific --notify flag from launch args.
 * --notify false  → disable notifications (OMC_NOTIFY=0)
 * --notify true   → enable notifications (default)
 * This flag must be stripped before passing args to Claude CLI.
 */
export declare function extractNotifyFlag(args: string[]): {
    notifyEnabled: boolean;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --openclaw flag from launch args.
 * Purely presence-based (like --madmax/--yolo):
 *   --openclaw        -> enable OpenClaw (OMC_OPENCLAW=1)
 *   --openclaw=true   -> enable OpenClaw
 *   --openclaw=false  -> disable OpenClaw
 *   --openclaw=1      -> enable OpenClaw
 *   --openclaw=0      -> disable OpenClaw
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractOpenClawFlag(args: string[]): {
    openclawEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --telegram flag from launch args.
 * Purely presence-based:
 *   --telegram        -> enable Telegram notifications (OMC_TELEGRAM=1)
 *   --telegram=true   -> enable
 *   --telegram=false  -> disable
 *   --telegram=1      -> enable
 *   --telegram=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractTelegramFlag(args: string[]): {
    telegramEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --discord flag from launch args.
 * Purely presence-based:
 *   --discord        -> enable Discord notifications (OMC_DISCORD=1)
 *   --discord=true   -> enable
 *   --discord=false  -> disable
 *   --discord=1      -> enable
 *   --discord=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractDiscordFlag(args: string[]): {
    discordEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --slack flag from launch args.
 * Purely presence-based:
 *   --slack        -> enable Slack notifications (OMC_SLACK=1)
 *   --slack=true   -> enable
 *   --slack=false  -> disable
 *   --slack=1      -> enable
 *   --slack=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractSlackFlag(args: string[]): {
    slackEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Extract the OMC-specific --webhook flag from launch args.
 * Purely presence-based:
 *   --webhook        -> enable Webhook notifications (OMC_WEBHOOK=1)
 *   --webhook=true   -> enable
 *   --webhook=false  -> disable
 *   --webhook=1      -> enable
 *   --webhook=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export declare function extractWebhookFlag(args: string[]): {
    webhookEnabled: boolean | undefined;
    remainingArgs: string[];
};
/**
 * Normalize Claude launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export declare function normalizeClaudeLaunchArgs(args: string[]): string[];
/**
 * preLaunch: Prepare environment before Claude starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export declare function preLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * Check if args contain --print or -p flag.
 * When in print mode, Claude outputs to stdout and must not be wrapped in tmux
 * (which would capture stdout and prevent piping to the parent process).
 */
export declare function isPrintMode(args: string[]): boolean;
/**
 * Detect raw --madmax / --yolo tokens in launch args. Used before
 * normalizeClaudeLaunchArgs strips them so we can apply OMC-specific
 * launch contracts (e.g. tmux-mandatory on macOS).
 */
export declare function hasMadmaxFlag(args: string[]): boolean;
/**
 * runClaude: Launch Claude CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch claude in current pane
 * 2. outside-tmux: Create new tmux session with claude
 * 3. direct: tmux not available, run claude directly
 *
 * When --print/-p is present, always runs direct to preserve stdout piping.
 *
 * On macOS, `--madmax` (and its `--yolo` alias) require tmux: if tmux is not
 * installed we exit with a brew install hint rather than silently launching
 * direct. Inside an existing tmux session the current pane is reused. If
 * tmux is installed but new-session/attach-session fails, we surface the
 * error instead of silently demoting to direct mode.
 */
export declare function runClaude(cwd: string, args: string[], sessionId: string): void;
/**
 * Env vars that must be forwarded into tmux sessions.
 * tmux new-session inherits the *server's* environment, not the calling
 * process's, so vars set on process.env (e.g. CLAUDE_CONFIG_DIR at launch)
 * are silently lost.  We inject them as `export` statements into the shell
 * command that runs inside the tmux pane, *after* .zshrc/.bashrc sourcing
 * so our values take precedence.
 */
export declare const TMUX_ENV_FORWARD: string[];
/**
 * Credential-shaped variables must never reach a command line.
 * `buildEnvExportPrefix` output is handed to tmux as an argument, so anything
 * it interpolates is readable through `/proc/<pid>/cmdline` (world-readable by
 * default on Linux) and through `#{pane_start_command}`. Pattern-matched
 * rather than enumerated so a newly supported provider key is contained by
 * default instead of leaking until someone remembers to add it.
 */
export declare function isSensitiveTmuxEnvironmentVariable(name: string): boolean;
export declare function buildEnvExportPrefix(vars: string[]): string;
export interface SensitiveEnvTransport {
    /** Shell fragment that loads the credentials and schedules artifact cleanup. */
    prefix: string;
    /** The secret-bearing file and its private parent directory. */
    paths: string[];
    /** Remove all artifacts immediately; safe to call more than once. */
    cleanup(): void;
}
/**
 * Forward credential-shaped variables through a private temporary transport.
 * The returned shell prefix contains only artifact paths; the credential
 * values are written to the transport file and loaded immediately before the
 * Claude command. Callers must invoke cleanup() whenever launch preparation or
 * tmux execution fails before the child shell can consume the prefix.
 *
 * POSIX shells source a 0600 `env.sh` file. Native Windows shells `call` a
 * 0600-equivalent `env.cmd` fragment; its parent temp directory and file are
 * removed by the command and by cleanup() on pre-execution failures. Windows
 * values retain the existing percent escaping and NUL/CR/LF rejection.
 */
export declare function buildSensitiveEnvFilePrefix(vars: string[]): SensitiveEnvTransport;
export declare function buildTmuxClaudeCommand(args: string[]): string;
/**
 * postLaunch: Cleanup after Claude exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export declare function postLaunch(_cwd: string, _sessionId: string): Promise<void>;
/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
/**
 * Parse `--plugin-dir <path>` / `--plugin-dir=<path>` from launch args (non-consuming).
 *
 * Returns the resolved absolute path if found, or null. The flag is NOT removed
 * from `args` — it must still forward to Claude Code's plugin loader untouched.
 */
export declare function parsePluginDirArg(args: string[]): string | null;
export declare function launchCommand(args: string[]): Promise<void>;
//# sourceMappingURL=launch.d.ts.map