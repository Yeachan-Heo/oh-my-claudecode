/**
 * CLI Detection Utility
 *
 * Detects whether Codex and Gemini CLIs are installed and available on the system PATH.
 * Results are cached per-session to avoid repeated filesystem checks.
 */
import { execSync } from 'child_process';
// Session-level cache for detection results
let codexCache = null;
let geminiCache = null;
/**
 * Detect if Codex CLI is installed and available
 */
export function detectCodexCli(useCache = true) {
    if (useCache && codexCache)
        return codexCache;
    const installHint = 'Install Codex CLI: npm install -g @openai/codex';
    try {
        const command = process.platform === 'win32' ? 'where codex' : 'which codex';
        const path = execSync(command, { encoding: 'utf-8', timeout: 5000 }).trim();
        let version;
        try {
            version = execSync('codex --version', { encoding: 'utf-8', timeout: 5000 }).trim();
        }
        catch {
            // Version check is optional
        }
        const result = { available: true, path, version, installHint };
        codexCache = result;
        return result;
    }
    catch {
        const result = {
            available: false,
            error: 'Codex CLI not found on PATH',
            installHint
        };
        codexCache = result;
        return result;
    }
}
/**
 * Detect if Gemini CLI is installed and available
 */
export function detectGeminiCli(useCache = true) {
    if (useCache && geminiCache)
        return geminiCache;
    const installHint = 'Install Gemini CLI: npm install -g @google/gemini-cli (see https://github.com/google-gemini/gemini-cli)';
    try {
        const command = process.platform === 'win32' ? 'where gemini' : 'which gemini';
        const path = execSync(command, { encoding: 'utf-8', timeout: 5000 }).trim();
        let version;
        try {
            version = execSync('gemini --version', { encoding: 'utf-8', timeout: 5000 }).trim();
        }
        catch {
            // Version check is optional
        }
        const result = { available: true, path, version, installHint };
        geminiCache = result;
        return result;
    }
    catch {
        const result = {
            available: false,
            error: 'Gemini CLI not found on PATH',
            installHint
        };
        geminiCache = result;
        return result;
    }
}
/**
 * Reset detection cache (useful for testing)
 */
export function resetDetectionCache() {
    codexCache = null;
    geminiCache = null;
}
//# sourceMappingURL=cli-detection.js.map