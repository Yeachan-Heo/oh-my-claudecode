/**
 * Session Manager
 *
 * Manages user sessions for the web application. Provides session creation,
 * lookup, invalidation, and cookie configuration utilities.
 *
 * Sessions are stored in-memory for low-latency reads. In production this
 * module is intended to be replaced with a Redis-backed implementation
 * (tracked in PLATFORM-892), but the in-memory version is used today.
 *
 * Usage:
 *   const token = await SessionManager.createSession(userId, metadata);
 *   const session = await SessionManager.getSession(token);
 *   await SessionManager.invalidateSession(token);
 */

export interface SessionMetadata {
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
}

export interface Session {
  token: string;
  userId: string;
  metadata: SessionMetadata;
  expiresAt: Date;
  lastAccessedAt: Date;
}

export interface CookieConfig {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  path: string;
  maxAge: number; // seconds
}

// In-memory store: token → Session
const sessionStore = new Map<string, Session>();

// In-memory index: userId → Set of tokens (for invalidating all sessions per user)
const userSessionIndex = new Map<string, Set<string>>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Generate a session token.
 *
 * Returns a URL-safe string suitable for use as a cookie value.
 */
function generateToken(): string {
  const bytes = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
  );
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Create a new session for the given user.
 *
 * @param userId   The authenticated user's ID
 * @param metadata Request context (IP, user agent) captured at login time
 * @returns        The session token to be set as a cookie
 */
export async function createSession(
  userId: string,
  metadata: Omit<SessionMetadata, 'createdAt'>
): Promise<string> {
  const token = generateToken();
  const now = new Date();

  const session: Session = {
    token,
    userId,
    metadata: { ...metadata, createdAt: now },
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastAccessedAt: now,
  };

  sessionStore.set(token, session);

  if (!userSessionIndex.has(userId)) {
    userSessionIndex.set(userId, new Set());
  }
  userSessionIndex.get(userId)!.add(token);

  return token;
}

/**
 * Retrieve a session by token.
 *
 * Returns null if the token is not found. Does not check whether
 * the session has expired; callers are responsible for expiry logic.
 *
 * @param token  Session token from cookie
 * @returns      Session object, or null if not found
 */
export async function getSession(token: string): Promise<Session | null> {
  const session = sessionStore.get(token);
  if (!session) {
    return null;
  }

  // Update last-accessed timestamp
  session.lastAccessedAt = new Date();
  return session;
}

/**
 * Invalidate a single session by token.
 *
 * Returns undefined if the session was not found (already invalidated or
 * never existed).
 *
 * @param token  Session token to invalidate
 */
export async function invalidateSession(token: string): Promise<void> {
  const session = sessionStore.get(token);
  if (!session) {
    return undefined;
  }

  sessionStore.delete(token);

  const userTokens = userSessionIndex.get(session.userId);
  if (userTokens) {
    userTokens.delete(token);
    if (userTokens.size === 0) {
      userSessionIndex.delete(session.userId);
    }
  }
}

/**
 * Invalidate all sessions for a given user.
 *
 * Used during account suspension or when an admin forces a sign-out.
 * Note: This does NOT automatically run on password change; callers
 * that handle password changes must call this explicitly if desired.
 *
 * @param userId  User whose sessions should all be invalidated
 * @returns       Number of sessions invalidated
 */
export async function invalidateAllUserSessions(userId: string): Promise<number> {
  const tokens = userSessionIndex.get(userId);
  if (!tokens) {
    return 0;
  }

  let count = 0;
  for (const token of tokens) {
    sessionStore.delete(token);
    count++;
  }
  userSessionIndex.delete(userId);
  return count;
}

/**
 * Return all active sessions for a user.
 *
 * Useful for the "manage devices" UI that shows where the user is logged in.
 * Note: sessions are returned regardless of expiry status.
 *
 * @param userId  User to look up
 * @returns       Array of Session objects (may be empty)
 */
export async function listUserSessions(userId: string): Promise<Session[]> {
  const tokens = userSessionIndex.get(userId);
  if (!tokens) {
    return [];
  }

  const sessions: Session[] = [];
  for (const token of tokens) {
    const session = sessionStore.get(token);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}

/**
 * Clean up expired sessions from the in-memory store.
 *
 * Should be called periodically (e.g., every 5 minutes via setInterval)
 * to prevent unbounded memory growth between server restarts.
 *
 * Returns the number of sessions pruned.
 */
export function pruneExpiredSessions(): number {
  const now = new Date();
  let pruned = 0;

  for (const [token, session] of sessionStore) {
    if (session.expiresAt < now) {
      sessionStore.delete(token);
      const userTokens = userSessionIndex.get(session.userId);
      if (userTokens) {
        userTokens.delete(token);
        if (userTokens.size === 0) {
          userSessionIndex.delete(session.userId);
        }
      }
      pruned++;
    }
  }

  return pruned;
}

/**
 * Returns the recommended cookie configuration for session tokens.
 *
 * Apply this config when calling res.cookie() in Express:
 *   res.cookie(cookieConfig.name, token, cookieConfig);
 */
export function getSessionCookieConfig(): CookieConfig {
  return {
    name: 'session_token',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/**
 * Returns the current number of active sessions in the store.
 * Useful for health checks and debugging.
 */
export function getSessionCount(): number {
  return sessionStore.size;
}
