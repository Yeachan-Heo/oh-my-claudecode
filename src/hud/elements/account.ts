/**
 * OMC HUD - Account Element
 *
 * Opt-in element that displays the signed-in Claude account's email address.
 * Useful when switching between accounts or profiles via CLAUDE_CONFIG_DIR.
 *
 * Security mitigations:
 * - Plain-email allowlist: rejects whitespace, C0/C1 controls, ESC, and bidi controls
 * - ~64-char middle-ellipsis cap
 * - O_NOFOLLOW | O_NONBLOCK open (no symlink/TOCTOU attacks)
 * - fstat verify: regular file only, size check
 * - Cache source path and metadata (mtimeMs, size, inode) to avoid stale emails
 * - Renders nothing when signed out or when auth comes from ANTHROPIC_API_KEY
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, type Stats } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { cyan } from '../colors.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { getOmcConfigDir } from '../../utils/config-dir.js';

interface AccountFileMetadata {
  mtimeMs: number;
  size: number;
  ino: number;
  isFile: boolean;
}

interface CachedAccountSource {
  path: string;
  metadata: AccountFileMetadata | null;
}

interface CachedAccountData {
  sources: CachedAccountSource[];
  email: string | null;
}

interface EmailValidationResult {
  valid: boolean;
  email?: string;
}

/**
 * Validate that a string is a plain email address without control characters,
 * whitespace, or bidi/direction controls.
 *
 * Rejects:
 * - Whitespace (U+0020, U+0009, U+000A, U+000D, etc.)
 * - C0 controls (U+0000–U+001F)
 * - C1 controls (U+0080–U+009F)
 * - ESC (U+001B)
 * - Bidi/direction controls (U+200E–200F, U+202A–202E, U+2066–2069)
 * - Non-ASCII characters (keep to basic ASCII email range)
 */
function validateEmail(value: unknown): EmailValidationResult {
  if (typeof value !== 'string') {
    return { valid: false };
  }

  // Quick length check first (cap at about 64 chars after truncation).
  if (value.length === 0 || value.length > 320) {
    return { valid: false };
  }

  // Check for control characters and bidi controls
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    
    // C0 controls (U+0000–U+001F), including TAB (0x09), LF (0x0A), CR (0x0D), ESC (0x1B)
    if (code <= 0x1f) {
      return { valid: false };
    }
    
    // C1 controls (U+0080–U+009F)
    if (code >= 0x80 && code <= 0x9f) {
      return { valid: false };
    }
    
    // Bidi/direction controls: U+200E–U+200F (LRM, RLM), U+202A–U+202E (LRE, RLE, PDF, LRO, RLO),
    // U+2066–U+2069 (LRI, RLI, FSI, PDI)
    if ((code >= 0x200e && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)) {
      return { valid: false };
    }
    
    // Whitespace (common variants)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c) {
      return { valid: false };
    }

    // Keep the rendered value to plain ASCII.
    if (code < 0x21 || code > 0x7e) {
      return { valid: false };
    }
  }

  // Basic sanity check: must contain @ and at least one dot after @
  if (!value.includes('@') || value.indexOf('@') !== value.lastIndexOf('@')) {
    return { valid: false };
  }

  const [local, domain] = value.split('@', 2);
  if (!local || !domain || !domain.includes('.')) {
    return { valid: false };
  }

  // Check domain part for valid characters (alphanumeric, dot, hyphen only)
  // to be conservative and prevent any weird injection vectors
  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    return { valid: false };
  }

  return { valid: true, email: value };
}

/**
 * Apply middle-ellipsis truncation to keep email under ~64 chars.
 * Caps at 64 visible chars with '...' in the middle.
 *
 * Example: "very.long.email.name+tag@very.long.domain.example.com" -> "very.long.email...@very.long.domain.example.com"
 */
function truncateEmailMiddle(email: string, maxChars: number = 64): string {
  if (email.length <= maxChars) {
    return email;
  }

  const ellipsis = '...';
  const availableChars = maxChars - ellipsis.length;
  const startChars = Math.floor(availableChars / 2);
  const endChars = availableChars - startChars;

  return `${email.slice(0, startChars)}${ellipsis}${email.slice(-endChars)}`;
}

/**
 * Read and validate an email from a .claude.json file with security hardening:
 * - O_NOFOLLOW to prevent symlink attacks
 * - fstat to verify regular file and size limit
 * - No path-based TOCTOU sequence (open → fstat → read uses the same fd)
 */
interface AccountReadResult {
  email: string | null;
  metadata: AccountFileMetadata | null;
}

function metadataFromStats(stats: Stats): AccountFileMetadata {
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ino: stats.ino,
    isFile: stats.isFile(),
  };
}

function getFileMetadata(filePath: string): AccountFileMetadata | null {
  try {
    return metadataFromStats(lstatSync(filePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function bestEffortFileMetadata(filePath: string): AccountFileMetadata | null {
  try {
    return getFileMetadata(filePath);
  } catch {
    return null;
  }
}

function readEmailFromClaudeJson(filePath: string): AccountReadResult {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    // Never retry without the protection flags if this open is rejected.
    fd = openSync(filePath, flags);
  } catch {
    return { email: null, metadata: bestEffortFileMetadata(filePath) };
  }

  try {
    // Verify the opened file descriptor before reading it; O_NONBLOCK also
    // ensures that opening a FIFO cannot hold the HUD render indefinitely.
    const metadata = metadataFromStats(fstatSync(fd));
    if (!metadata.isFile || metadata.size > 5 * 1024 * 1024) {
      return { email: null, metadata };
    }

    try {
      const content = readFileSync(fd, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { email: null, metadata };
      }

      const account = (parsed as Record<string, unknown>).oauthAccount;
      if (typeof account !== 'object' || account === null || Array.isArray(account)) {
        return { email: null, metadata };
      }

      const email = (account as Record<string, unknown>).emailAddress;
      const validation = validateEmail(email);
      return { email: validation.valid ? validation.email ?? null : null, metadata };
    } catch {
      return { email: null, metadata };
    }
  } catch {
    return { email: null, metadata: bestEffortFileMetadata(filePath) };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore close errors in cleanup.
    }
  }
}

function metadataEquals(a: AccountFileMetadata | null, b: AccountFileMetadata | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino && a.isFile === b.isFile;
}

function isAccountFileMetadata(value: unknown): value is AccountFileMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const m = value as Partial<AccountFileMetadata>;
  return [m.mtimeMs, m.size, m.ino].every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    typeof m.isFile === 'boolean';
}

function isCachedAccountData(value: unknown): value is CachedAccountData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cached = value as Partial<CachedAccountData>;
  return (cached.email === null || typeof cached.email === 'string') &&
    Array.isArray(cached.sources) &&
    cached.sources.every((source: unknown) => {
      if (typeof source !== 'object' || source === null) return false;
      const { path, metadata } = source as Partial<CachedAccountSource>;
      return typeof path === 'string' && (metadata === null || isAccountFileMetadata(metadata));
    });
}

/**
 * Read the account email from .claude.json with caching.
 * Checks $CLAUDE_CONFIG_DIR/.claude.json first, then falls back to ~/.claude.json.
 */
function getCachedAccountEmail(): string | null {
  const cacheDir = getOmcConfigDir();
  const cacheFile = join(cacheDir, 'hud-account-cache.json');
  const configJsonPath = join(getClaudeConfigDir(), '.claude.json');
  const fallbackPath = join(homedir(), '.claude.json');

  const candidatePaths = fallbackPath === configJsonPath ? [configJsonPath] : [configJsonPath, fallbackPath];
  // Snapshot every candidate before reading, so a change to any of them
  // (account switch, sign-out, or a new login appearing in either location)
  // invalidates the cache on the next render.
  // A candidate that cannot be inspected (e.g. EACCES on its directory) makes
  // the cache unverifiable, so bypass it rather than trusting or writing it.
  let cacheable = true;
  const sources: CachedAccountSource[] = candidatePaths.map((path) => {
    try {
      return { path, metadata: getFileMetadata(path) };
    } catch {
      cacheable = false;
      return { path, metadata: null };
    }
  });

  try {
    const cache = cacheable ? JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, unknown> : {};
    const cached = cache.account;
    if (
      isCachedAccountData(cached) &&
      cached.sources.length === sources.length &&
      cached.sources.every((entry, i) => entry.path === sources[i].path && metadataEquals(entry.metadata, sources[i].metadata)) &&
      (cached.email === null || validateEmail(cached.email).valid)
    ) {
      return cached.email;
    }
  } catch {
    // Ignore missing, stale, or malformed cache data and recompute.
  }

  let email: string | null = null;
  for (const path of candidatePaths) {
    email = readEmailFromClaudeJson(path).email;
    if (email) break;
  }

  if (!cacheable) return email;

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ account: { sources, email } satisfies CachedAccountData }));
  } catch {
    // Ignore cache update errors; the feature still works without cache
  }

  return email;
}

/**
 * Render the account email element.
 *
 * Format: acct:<email>
 *
 * Returns null if:
 * - No email is available
 * - Email validation fails
 * - Signed out (no .claude.json or no oauthAccount)
 * - Auth comes from API key (email would not be present)
 */
export function renderAccount(): string | null {
  // Check if we have an API key in use (which would mean OAuth email is not available)
  if (process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  let email: string | null;
  try {
    email = getCachedAccountEmail();
  } catch {
    // An unreadable account source must never take down the whole HUD.
    return null;
  }
  if (!email) {
    return null;
  }

  // Apply middle-ellipsis truncation
  const truncated = truncateEmailMiddle(email, 64);

  return cyan(`acct:${truncated}`);
}
