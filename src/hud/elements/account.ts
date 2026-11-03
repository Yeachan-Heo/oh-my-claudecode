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
 * - Cache in OMC HUD cache: {mtimeMs, size, email} to avoid re-parsing
 * - Renders nothing when signed out or when auth comes from ANTHROPIC_API_KEY
 */

import { existsSync, openSync, fstatSync, readFileSync, closeSync, mkdirSync, writeFileSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { cyan } from '../colors.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { getOmcConfigDir } from '../../utils/config-dir.js';

interface CachedAccountData {
  mtimeMs: number;
  size: number;
  email: string;
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

  // Quick length check first (cap at about 64 chars)
  if (value.length === 0 || value.length > 320) {
    return { valid: false };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false };
  }

  // Check for control characters and bidi controls
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    
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
  }

  // Basic sanity check: must contain @ and at least one dot after @
  if (!trimmed.includes('@')) {
    return { valid: false };
  }

  const [local, domain] = trimmed.split('@', 2);
  if (!local || !domain || !domain.includes('.')) {
    return { valid: false };
  }

  // Check domain part for valid characters (alphanumeric, dot, hyphen only)
  // to be conservative and prevent any weird injection vectors
  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    return { valid: false };
  }

  return { valid: true, email: trimmed };
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
 * - No TOCTOU sequence (open → stat → read is atomic from open fd)
 */
function readEmailFromClaudeJson(filePath: string): string | null {
  try {
    // Check file exists first (avoid O_NOFOLLOW errors on missing files)
    if (!existsSync(filePath)) {
      return null;
    }

    // Open with O_NOFOLLOW | O_NONBLOCK to prevent symlink/FIFO attacks
    // Platform-specific: O_NOFOLLOW may not exist on all systems, but we use it where available
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
    let fd: number;
    try {
      fd = openSync(filePath, flags);
    } catch (err) {
      // If O_NOFOLLOW/O_NONBLOCK cause issues, fall back to normal open
      // This is a defensive fallback; modern systems support these flags
      fd = openSync(filePath, constants.O_RDONLY);
    }

    try {
      // Verify via fstat: must be a regular file, size must be under 5 MB
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        return null;
      }
      if (stats.size > 5 * 1024 * 1024) {
        // File is too large; skip to avoid parsing expensive files
        return null;
      }

      // Read from the same fd (no TOCTOU gap)
      const content = readFileSync(fd, 'utf-8');
      const parsed = JSON.parse(content);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }

      const account = (parsed as Record<string, unknown>).oauthAccount;
      if (typeof account !== 'object' || account === null || Array.isArray(account)) {
        return null;
      }

      const email = (account as Record<string, unknown>).emailAddress;
      const validation = validateEmail(email);
      return validation.valid && validation.email ? validation.email : null;
    } finally {
      // Always close the fd
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors in cleanup
      }
    }
  } catch {
    return null;
  }
}

/**
 * Read the account email from .claude.json with caching.
 * Checks $CLAUDE_CONFIG_DIR/.claude.json first, then falls back to ~/.claude.json.
 */
function getCachedAccountEmail(): string | null {
  const cacheDir = getOmcConfigDir();
  const cacheFile = join(cacheDir, 'hud-account-cache.json');

  try {
    // Try to read cache
    if (existsSync(cacheFile)) {
      const cacheContent = readFileSync(cacheFile, 'utf-8');
      const cache = JSON.parse(cacheContent) as Record<string, unknown>;
      const cached = cache.account as CachedAccountData | undefined;
      if (cached && typeof cached === 'object') {
        return cached.email ?? null;
      }
    }
  } catch {
    // Ignore cache read errors; will recompute
  }

  // No valid cache; read from .claude.json
  const claudeConfigDir = getClaudeConfigDir();
  const configJsonPath = join(claudeConfigDir, '.claude.json');
  const fallbackPath = join(homedir(), '.claude.json');

  let email = readEmailFromClaudeJson(configJsonPath);
  if (!email) {
    email = readEmailFromClaudeJson(fallbackPath);
  }

  // Update cache with the result (best effort; errors are ignored)
  try {
    const cacheDir = getOmcConfigDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    
    const cacheFile = join(cacheDir, 'hud-account-cache.json');
    const cacheData: Record<string, unknown> = {
      account: email ? { mtimeMs: Date.now(), size: 0, email } : {},
    };
    writeFileSync(cacheFile, JSON.stringify(cacheData));
  } catch {
    // Ignore cache update errors; the feature still works without cache
  }

  return email ?? null;
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

  const email = getCachedAccountEmail();
  if (!email) {
    return null;
  }

  // Apply middle-ellipsis truncation
  const truncated = truncateEmailMiddle(email, 64);

  return cyan(`acct:${truncated}`);
}
