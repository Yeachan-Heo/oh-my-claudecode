// src/team/permissions.ts

/**
 * RBAC-compatible advisory permission scoping for workers.
 *
 * NOTE: This is an advisory layer only. MCP workers run in full-auto mode
 * and cannot be mechanically restricted. Permissions are injected into
 * prompts as instructions for the LLM to follow.
 */

import { relative, resolve } from 'node:path';

export interface WorkerPermissions {
  workerName: string;
  allowedPaths: string[];   // glob patterns relative to workingDirectory
  deniedPaths: string[];    // glob patterns that override allowed
  allowedCommands: string[]; // command prefixes (e.g., 'npm test', 'tsc')
  maxFileSize: number;      // max bytes per file write
}

/**
 * Simple glob matching for path patterns.
 * Supports: * (any non-/ chars), ** (any depth including /), ? (single non-/ char), exact match.
 *
 * Uses iterative character-by-character matching to avoid ReDoS risk from regex.
 */
function matchGlob(pattern: string, path: string): boolean {
  let pi = 0; // pattern index
  let si = 0; // string (path) index
  let starPi = -1; // pattern index after last '*' fallback point
  let starSi = -1; // string index at last '*' fallback point

  while (si < path.length) {
    // Check for '**' (matches anything including '/')
    if (pi < pattern.length - 1 && pattern[pi] === '*' && pattern[pi + 1] === '*') {
      // Consume the '**'
      pi += 2;
      // Skip trailing '/' after '**' if present
      if (pi < pattern.length && pattern[pi] === '/') pi++;
      starPi = pi;
      starSi = si;
      continue;
    }

    // Check for single '*' (matches any non-/ chars)
    if (pi < pattern.length && pattern[pi] === '*') {
      pi++;
      starPi = pi;
      starSi = si;
      continue;
    }

    // Check for '?' (matches single non-/ char)
    if (pi < pattern.length && pattern[pi] === '?' && path[si] !== '/') {
      pi++;
      si++;
      continue;
    }

    // Exact character match
    if (pi < pattern.length && pattern[pi] === path[si]) {
      pi++;
      si++;
      continue;
    }

    // Mismatch: backtrack to last star if possible
    if (starPi !== -1) {
      pi = starPi;
      starSi++;
      si = starSi;

      // For single '*', don't match across '/'
      // We detect this by checking if the star was a '**' or '*'
      // If we got here from '**', slashes are OK; from '*', skip if slash
      // Re-check: was the star a '**'?
      const wasSingleStar =
        starPi >= 2 && pattern[starPi - 2] === '*' && pattern[starPi - 1] === '*' ? false :
        starPi >= 1 && pattern[starPi - 1] === '*' ? true : false;

      if (wasSingleStar && si > 0 && path[si - 1] === '/') {
        return false;
      }
      continue;
    }

    return false;
  }

  // Consume remaining pattern characters (trailing '*' or '**')
  while (pi < pattern.length) {
    if (pattern[pi] === '*') {
      pi++;
    } else if (pattern[pi] === '/') {
      // Allow trailing slash in pattern after '**'
      pi++;
    } else {
      break;
    }
  }

  return pi === pattern.length;
}

/**
 * Check if a worker is allowed to modify a given path.
 * Denied paths override allowed paths.
 */
export function isPathAllowed(
  permissions: WorkerPermissions,
  filePath: string,
  workingDirectory: string
): boolean {
  // Normalize to relative path
  const absPath = resolve(workingDirectory, filePath);
  const relPath = relative(workingDirectory, absPath);

  // If path escapes working directory, always deny
  if (relPath.startsWith('..')) return false;

  // Check denied paths first (they override)
  for (const pattern of permissions.deniedPaths) {
    if (matchGlob(pattern, relPath)) return false;
  }

  // If no allowed paths specified, allow all within workingDirectory
  if (permissions.allowedPaths.length === 0) return true;

  // Check allowed paths
  for (const pattern of permissions.allowedPaths) {
    if (matchGlob(pattern, relPath)) return true;
  }

  return false;
}

/**
 * Check if a worker is allowed to run a given command.
 * Empty allowedCommands means all commands are allowed.
 */
export function isCommandAllowed(
  permissions: WorkerPermissions,
  command: string
): boolean {
  if (permissions.allowedCommands.length === 0) return true;

  const trimmed = command.trim();
  return permissions.allowedCommands.some(prefix =>
    trimmed.startsWith(prefix)
  );
}

/**
 * Generate permission instructions for inclusion in worker prompt.
 */
export function formatPermissionInstructions(
  permissions: WorkerPermissions
): string {
  const lines: string[] = [];
  lines.push('PERMISSION CONSTRAINTS:');

  if (permissions.allowedPaths.length > 0) {
    lines.push(`- You may ONLY modify files matching: ${permissions.allowedPaths.join(', ')}`);
  }

  if (permissions.deniedPaths.length > 0) {
    lines.push(`- You must NOT modify files matching: ${permissions.deniedPaths.join(', ')}`);
  }

  if (permissions.allowedCommands.length > 0) {
    lines.push(`- You may ONLY run commands starting with: ${permissions.allowedCommands.join(', ')}`);
  }

  if (Number.isFinite(permissions.maxFileSize)) {
    lines.push(`- Maximum file size: ${Math.round(permissions.maxFileSize / 1024)}KB per file`);
  }

  if (lines.length === 1) {
    lines.push('- No restrictions (full access within working directory)');
  }

  return lines.join('\n');
}

/**
 * Default permissions (allow all within working directory).
 */
export function getDefaultPermissions(workerName: string): WorkerPermissions {
  return {
    workerName,
    allowedPaths: [],     // empty = allow all
    deniedPaths: [],
    allowedCommands: [],  // empty = allow all
    maxFileSize: Infinity,
  };
}

/**
 * Secure deny-defaults that are always enforced regardless of caller config.
 * These protect sensitive files from being modified by any worker.
 */
const SECURE_DENY_DEFAULTS: string[] = [
  '.git/**',
  '.env*',
  '**/.env*',
  '**/secrets/**',
  '**/.ssh/**',
  '**/node_modules/.cache/**',
];

/**
 * Merge caller-provided permissions with secure deny-defaults.
 * The deny-defaults are always prepended to deniedPaths so they cannot be overridden.
 */
export function getEffectivePermissions(base?: Partial<WorkerPermissions> & { workerName: string }): WorkerPermissions {
  const perms = base
    ? { ...getDefaultPermissions(base.workerName), ...base }
    : getDefaultPermissions('default');

  // Prepend secure defaults (deduplicating against existing deniedPaths)
  const existingSet = new Set(perms.deniedPaths);
  const merged = [
    ...SECURE_DENY_DEFAULTS.filter(p => !existingSet.has(p)),
    ...perms.deniedPaths,
  ];
  perms.deniedPaths = merged;

  return perms;
}

/** A single permission violation */
export interface PermissionViolation {
  path: string;
  reason: string;
}

/**
 * Check a list of changed file paths against permissions.
 * Returns an array of violations (empty = all paths allowed).
 *
 * @param changedPaths - relative or absolute paths of files that were modified
 * @param permissions - effective permissions to check against
 * @param cwd - working directory for resolving relative paths
 */
export function findPermissionViolations(
  changedPaths: string[],
  permissions: WorkerPermissions,
  cwd: string
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];

  for (const filePath of changedPaths) {
    if (!isPathAllowed(permissions, filePath, cwd)) {
      // Determine which deny pattern matched for the reason
      const absPath = resolve(cwd, filePath);
      const relPath = relative(cwd, absPath);

      let reason: string;
      if (relPath.startsWith('..')) {
        reason = `Path escapes working directory: ${relPath}`;
      } else {
        // Find which deny pattern matched
        const matchedDeny = permissions.deniedPaths.find(p => matchGlob(p, relPath));
        if (matchedDeny) {
          reason = `Matches denied pattern: ${matchedDeny}`;
        } else {
          reason = `Not in allowed paths: ${permissions.allowedPaths.join(', ') || '(none configured)'}`;
        }
      }

      violations.push({ path: relPath, reason });
    }
  }

  return violations;
}
