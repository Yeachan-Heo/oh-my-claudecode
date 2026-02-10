/**
 * Path utilities for Python REPL tool
 *
 * Provides secure path resolution for session directories, sockets, and metadata.
 * Uses OS-appropriate runtime directories outside the project root.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
// =============================================================================
// CONSTANTS
// =============================================================================
/**
 * Maximum length for Unix socket paths (Linux: 108, macOS: 104).
 * We use a conservative value that works on both platforms.
 */
const MAX_SOCKET_PATH_LENGTH = 100;
/**
 * Length of the short session ID hash used for socket paths.
 * 12 hex chars = 6 bytes = 281 trillion possible values, negligible collision risk.
 */
const SHORT_SESSION_ID_LENGTH = 12;
/**
 * Windows reserved device names that cannot be used as file names.
 * These names cause issues on Windows regardless of file extension.
 * Applied unconditionally (portable-safe) to prevent cross-platform issues.
 */
const WINDOWS_RESERVED_NAMES = new Set([
    // Standard reserved device names
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
// =============================================================================
// RUNTIME DIRECTORY RESOLUTION
// =============================================================================
/**
 * Validate XDG_RUNTIME_DIR security properties.
 * On multi-user systems, XDG_RUNTIME_DIR can be poisoned if not validated.
 * @param dir - XDG_RUNTIME_DIR path to validate
 * @returns true if the directory is secure (exists, not symlink, owned by uid, mode 0700)
 */
function isSecureRuntimeDir(dir) {
    // Must be absolute path (prevents XDG_RUNTIME_DIR="." exploits)
    if (!path.isAbsolute(dir))
        return false;
    try {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return false;
        if (stat.uid !== process.getuid?.())
            return false;
        if ((stat.mode & 0o777) !== 0o700)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Get the path to the runtime directory.
 * Contains ephemeral session data like locks and sockets.
 * Uses OS-appropriate temp directories.
 *
 * Priority:
 * 1. XDG_RUNTIME_DIR/omc (Linux standard, usually /run/user/{uid})
 * 2. Platform-specific user cache directory
 * 3. os.tmpdir() fallback
 *
 * @returns Path to runtime directory
 *
 * @example
 * getRuntimeDir();
 * // Linux with XDG: '/run/user/1000/omc'
 * // macOS: '~/Library/Caches/omc/runtime'
 * // Fallback: '/tmp/omc/runtime'
 */
export function getRuntimeDir() {
    // Priority 1: XDG_RUNTIME_DIR (Linux standard, usually /run/user/{uid})
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime && isSecureRuntimeDir(xdgRuntime)) {
        return path.join(xdgRuntime, "omc");
    }
    // Priority 2: Platform-specific user cache directory
    const platform = process.platform;
    if (platform === "darwin") {
        return path.join(os.homedir(), "Library", "Caches", "omc", "runtime");
    }
    else if (platform === "linux") {
        // Linux fallback - use /tmp (XDG validation failed)
        return path.join("/tmp", "omc", "runtime");
    }
    else if (platform === "win32") {
        // Windows: use LOCALAPPDATA (e.g., C:\Users\<user>\AppData\Local)
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(localAppData, "omc", "runtime");
    }
    // Priority 3: Final fallback to os.tmpdir() for any other platform
    return path.join(os.tmpdir(), "omc", "runtime");
}
// =============================================================================
// SESSION PATH UTILITIES
// =============================================================================
/**
 * Shorten a session ID to fit within Unix socket path constraints.
 * Uses SHA256 hash truncated to 12 hex chars (48 bits).
 *
 * Unix sockets have path length limits (UNIX_PATH_MAX):
 * - Linux: 108 bytes
 * - macOS: 104 bytes
 *
 * SECURITY: Always hashes the input, even for short IDs.
 * This prevents path traversal attacks via malicious short IDs like ".." or "../x".
 *
 * @param sessionId - Original session identifier (can be any length)
 * @returns Short identifier (12 hex chars) suitable for socket paths
 */
export function shortenSessionId(sessionId) {
    // SECURITY: Always hash - do not return raw input even for short IDs
    // This prevents traversal attacks like "../.." which is only 5 chars
    return crypto
        .createHash("sha256")
        .update(sessionId)
        .digest("hex")
        .slice(0, SHORT_SESSION_ID_LENGTH);
}
/**
 * Get the path to a specific session's runtime directory.
 * Uses shortened session ID to ensure socket paths stay within limits.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to runtime/{shortId}/ in OS temp directory
 */
export function getSessionDir(sessionId) {
    const shortId = shortenSessionId(sessionId);
    return path.join(getRuntimeDir(), shortId);
}
/**
 * Get the path to a session's bridge socket.
 * Path is kept short to respect Unix socket path limits (~108 bytes).
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to bridge.sock in session's runtime directory
 */
export function getBridgeSocketPath(sessionId) {
    return path.join(getSessionDir(sessionId), "bridge.sock");
}
/**
 * Get the path to a session's bridge metadata file.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to bridge_meta.json in session's runtime directory
 */
export function getBridgeMetaPath(sessionId) {
    return path.join(getSessionDir(sessionId), "bridge_meta.json");
}
/**
 * Get the path to a session's lock file.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to session.lock in session's runtime directory
 */
export function getSessionLockPath(sessionId) {
    return path.join(getSessionDir(sessionId), "session.lock");
}
// =============================================================================
// PATH VALIDATION
// =============================================================================
/**
 * Validates that a path segment is safe to use in file paths.
 * Prevents directory traversal and path injection attacks.
 *
 * @param segment - The path segment to validate (e.g., session ID, file name)
 * @param name - Name of the parameter for error messages (e.g., "sessionId", "filename")
 * @throws Error if segment is invalid
 *
 * @example
 * validatePathSegment("my-session-123", "sessionId"); // OK
 * validatePathSegment("../evil", "sessionId"); // throws Error
 */
export function validatePathSegment(segment, name) {
    if (!segment || typeof segment !== "string") {
        throw new Error(`${name} is required and must be a string`);
    }
    if (segment.trim().length === 0) {
        throw new Error(`Invalid ${name}: cannot be empty or whitespace`);
    }
    // Normalize Unicode to prevent bypass via alternative representations
    const normalized = segment.normalize("NFC");
    // Prevent path traversal attacks
    // Block both ".." (parent directory) and path separators
    if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
        throw new Error(`Invalid ${name}: contains path traversal characters`);
    }
    // Prevent null bytes
    if (normalized.includes("\0")) {
        throw new Error(`Invalid ${name}: contains null byte`);
    }
    // Limit byte length (filesystems typically limit to 255 bytes, not chars)
    if (Buffer.byteLength(normalized, "utf8") > 255) {
        throw new Error(`Invalid ${name}: exceeds maximum length of 255 bytes`);
    }
    // Reject Windows reserved device names (portable-safe)
    // Handle COM1.txt, NUL.txt etc (anything starting with reserved name + optional extension)
    // Trim trailing spaces/dots from baseName to prevent bypass via "CON .txt" or "NUL..txt"
    const upperSegment = normalized.toUpperCase();
    const baseName = upperSegment.split('.')[0].replace(/[ .]+$/, "");
    if (WINDOWS_RESERVED_NAMES.has(baseName)) {
        throw new Error(`${name} contains Windows reserved name: ${segment}`);
    }
    // Reject trailing dots or spaces (Windows path confusion)
    if (normalized.endsWith('.') || normalized.endsWith(' ')) {
        throw new Error(`${name} has trailing dot or space: ${segment}`);
    }
}
//# sourceMappingURL=paths.js.map