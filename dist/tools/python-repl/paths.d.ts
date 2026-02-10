/**
 * Path utilities for Python REPL tool
 *
 * Provides secure path resolution for session directories, sockets, and metadata.
 * Uses OS-appropriate runtime directories outside the project root.
 */
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
export declare function getRuntimeDir(): string;
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
export declare function shortenSessionId(sessionId: string): string;
/**
 * Get the path to a specific session's runtime directory.
 * Uses shortened session ID to ensure socket paths stay within limits.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to runtime/{shortId}/ in OS temp directory
 */
export declare function getSessionDir(sessionId: string): string;
/**
 * Get the path to a session's bridge socket.
 * Path is kept short to respect Unix socket path limits (~108 bytes).
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to bridge.sock in session's runtime directory
 */
export declare function getBridgeSocketPath(sessionId: string): string;
/**
 * Get the path to a session's bridge metadata file.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to bridge_meta.json in session's runtime directory
 */
export declare function getBridgeMetaPath(sessionId: string): string;
/**
 * Get the path to a session's lock file.
 *
 * @param sessionId - Unique identifier for the session
 * @returns Path to session.lock in session's runtime directory
 */
export declare function getSessionLockPath(sessionId: string): string;
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
export declare function validatePathSegment(segment: string, name: string): void;
//# sourceMappingURL=paths.d.ts.map