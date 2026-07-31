// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract } from './model-contract.js';
import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
const RESOLVE_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 3000;
const SAFE_BINARY_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_BATCH_PATH = /^[A-Za-z]:\\(?:[A-Za-z0-9 ._-]+\\)*[A-Za-z0-9 ._-]+\.(?:cmd|bat)$/i;
const VALID_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const ADMITTED_BATCH_START_ERRORS = new Set(['ENOENT', 'UNKNOWN', 'EINVAL']);
const DEFAULT_COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const INVALID_BINARY_ERROR = 'invalid CLI name';
const RESOLVER_ERROR = 'CLI resolver failed';
const VERSION_ERROR = 'version probe failed';
const VERSION_NO_OUTPUT_ERROR = 'version probe returned no output';
const UNSAFE_BATCH_ERROR = 'version probe skipped: batch path is not literal-safe';
function platformModel(platform) {
    const isWindows = platform === 'win32';
    return {
        isWindows,
        finder: isWindows ? 'where.exe' : 'which',
        pathFlavor: isWindows ? path.win32 : path.posix,
    };
}
function asText(value) {
    if (typeof value === 'string')
        return value;
    if (Buffer.isBuffer(value))
        return value.toString('utf8');
    return value == null ? '' : String(value);
}
function firstNonblankLine(value) {
    for (const line of asText(value).split(/\r\n|\n|\r/)) {
        const trimmed = line.trim();
        if (trimmed)
            return trimmed;
    }
    return undefined;
}
function isValidBinaryName(binary) {
    return typeof binary === 'string' && SAFE_BINARY_NAME.test(binary);
}
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function resolveCliPath(binary, model) {
    let result;
    try {
        result = spawnSync(model.finder, [binary], {
            timeout: RESOLVE_TIMEOUT_MS,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
        });
    }
    catch {
        return undefined;
    }
    // A finder error, timeout, signal, or nonzero exit is a resolution failure.
    if (result.error || result.signal || result.status !== 0)
        return undefined;
    const stdout = asText(result.stdout);
    for (const line of stdout.split(/\r\n|\n|\r/)) {
        const candidate = line.trim();
        if (candidate && model.pathFlavor.isAbsolute(candidate))
            return candidate;
    }
    return undefined;
}
function directVersionOptions() {
    return {
        timeout: VERSION_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
    };
}
function isLiteralSafeBatchPath(resolvedPath) {
    return SAFE_BATCH_PATH.test(resolvedPath);
}
function isBatchPath(resolvedPath, model) {
    if (!model.isWindows)
        return false;
    const extension = model.pathFlavor.extname(resolvedPath).toLowerCase();
    return VALID_BATCH_EXTENSIONS.has(extension);
}
function isValidatedComspec(candidate) {
    if (!candidate || /[\0\r\n]/.test(candidate) || /[\\/]$/.test(candidate))
        return false;
    if (!path.win32.isAbsolute(candidate))
        return false;
    return path.win32.basename(candidate).toLowerCase() === 'cmd.exe';
}
function validatedComspec() {
    const configured = process.env.ComSpec ?? process.env.COMSPEC;
    if (isValidatedComspec(configured))
        return configured;
    try {
        if (existsSync(DEFAULT_COMSPEC) && isValidatedComspec(DEFAULT_COMSPEC))
            return DEFAULT_COMSPEC;
    }
    catch {
        // An unavailable filesystem probe only disables optional enrichment.
    }
    return undefined;
}
function canUseBatchFallback(resolvedPath, directResult, model) {
    if (!model.isWindows || !isBatchPath(resolvedPath, model))
        return false;
    if (directResult.status !== null || directResult.signal !== null || !directResult.error)
        return false;
    return ADMITTED_BATCH_START_ERRORS.has(errorCode(directResult.error) ?? '');
}
function runBatchVersion(resolvedPath) {
    const comspec = validatedComspec();
    if (!comspec)
        return undefined;
    // cmd.exe parses the raw command tail itself. The closed path grammar makes
    // this fixed payload safe to pass verbatim and avoids Node re-quoting it.
    try {
        return spawnSync(comspec, ['/d', '/v:off', '/s', '/c', `""${resolvedPath}" --version"`], {
            timeout: VERSION_TIMEOUT_MS,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: process.env,
        });
    }
    catch {
        return undefined;
    }
}
function failedVersionResult(resolvedPath, error = VERSION_ERROR) {
    return {
        found: true,
        path: resolvedPath,
        error,
        versionExitedZero: false,
    };
}
function successfulVersionResult(resolvedPath, result) {
    const version = firstNonblankLine(result.stdout);
    if (!version) {
        return {
            found: true,
            path: resolvedPath,
            error: VERSION_NO_OUTPUT_ERROR,
            versionExitedZero: true,
        };
    }
    return {
        found: true,
        path: resolvedPath,
        version,
        versionExitedZero: true,
    };
}
function executeCliProbe(binary, platform) {
    if (!isValidBinaryName(binary)) {
        return { found: false, error: INVALID_BINARY_ERROR, versionExitedZero: false };
    }
    const model = platformModel(platform);
    const resolvedPath = resolveCliPath(binary, model);
    if (!resolvedPath) {
        return { found: false, error: RESOLVER_ERROR, versionExitedZero: false };
    }
    let directResult;
    try {
        directResult = spawnSync(resolvedPath, ['--version'], directVersionOptions());
    }
    catch {
        return failedVersionResult(resolvedPath);
    }
    if (directResult.status === 0 && !directResult.signal) {
        return successfulVersionResult(resolvedPath, directResult);
    }
    if (canUseBatchFallback(resolvedPath, directResult, model)) {
        if (!isLiteralSafeBatchPath(resolvedPath)) {
            return failedVersionResult(resolvedPath, UNSAFE_BATCH_ERROR);
        }
        const batchResult = runBatchVersion(resolvedPath);
        if (!batchResult || batchResult.status !== 0 || batchResult.signal) {
            return failedVersionResult(resolvedPath);
        }
        return successfulVersionResult(resolvedPath, batchResult);
    }
    return failedVersionResult(resolvedPath);
}
/** Resolve a provider CLI and perform a bounded, shell-free optional version probe. */
export function probeCli(binary, platform = process.platform) {
    const result = executeCliProbe(binary, platform);
    return {
        found: result.found,
        ...(result.path === undefined ? {} : { path: result.path }),
        ...(result.version === undefined ? {} : { version: result.version }),
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}
/**
 * Legacy detector projection. `available` intentionally remains tied to a
 * status-zero version process rather than to successful path resolution.
 */
export function detectCli(binary) {
    const result = executeCliProbe(binary, process.platform);
    if (!result.versionExitedZero)
        return { available: false };
    return {
        available: true,
        version: result.version ?? '',
        path: result.path,
    };
}
export function detectAllClis() {
    return {
        claude: detectCli('claude'),
        codex: detectCli('codex'),
        gemini: detectCli('gemini'),
        cursor: detectCli('cursor-agent'),
        grok: detectCli('grok'),
        antigravity: detectCli('agy'),
    };
}
//# sourceMappingURL=cli-detection.js.map