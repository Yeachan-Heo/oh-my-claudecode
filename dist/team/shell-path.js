/**
 * Resolve the user's full shell PATH.
 *
 * MCP server processes are spawned by the Claude Code plugin system and may
 * not inherit the user's interactive-shell PATH. Tools installed via version
 * managers (mise, asdf, nvm, fnm, volta, etc.) or into /usr/local/bin are
 * therefore invisible to child_process.spawn/spawnSync.
 *
 * This module resolves the real PATH once (lazy, cached) by running a login
 * shell and reading $PATH from it.
 */
import { spawnSync } from 'child_process';
let _resolved = null;
/**
 * Return the user's full interactive-shell PATH, falling back to
 * process.env.PATH when resolution fails.
 *
 * Parses `env` output instead of `echo $PATH` to avoid stdout noise
 * from interactive dotfiles (conda init, greeting messages).
 *
 * Note: On fish shell, the `-ilc` combined flags are not supported
 * (fish requires `--login --interactive -c`), so resolution falls
 * back to process.env.PATH. On Windows, SHELL is unset and
 * resolution also falls back gracefully.
 */
export function resolveShellPath() {
    if (_resolved !== null)
        return _resolved;
    // On Windows, SHELL is unset and /bin/sh does not exist.
    // Skip the spawn attempt to avoid a guaranteed-to-fail 5s timeout.
    if (process.platform === 'win32') {
        _resolved = process.env.PATH || '';
        return _resolved;
    }
    try {
        const shell = process.env.SHELL || '/bin/sh';
        // Use `env` and parse PATH= line — works across all shells (bash, zsh, fish)
        // and avoids stdout noise from interactive dotfiles (.bashrc, .zshrc, config.fish).
        const result = spawnSync(shell, ['-ilc', 'env'], {
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (result.status === 0) {
            const stdout = result.stdout?.toString() ?? '';
            const pathLine = stdout.split('\n').find(l => l.startsWith('PATH='));
            const path = pathLine?.slice(5)?.trim();
            if (path) {
                _resolved = path;
                return _resolved;
            }
        }
    }
    catch {
        // fall through
    }
    _resolved = process.env.PATH || '';
    return _resolved;
}
/**
 * Return a copy of process.env with the resolved PATH merged in.
 * Handles Windows where the key may be `Path` instead of `PATH`.
 */
export function resolvedEnv(extra) {
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = resolveShellPath();
    return { ...env, ...extra };
}
/** @internal For testing only. Resets the cached PATH so the next call re-resolves. */
export function _resetShellPathCache() {
    _resolved = null;
}
//# sourceMappingURL=shell-path.js.map