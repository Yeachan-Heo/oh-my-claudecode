import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJevEnv } from '../jev-resolve.mjs';

/**
 * Get the Jev mode for a point: 'off' | 'shadow' | 'active'.
 * Reuses the script resolver's config gates and union activation semantics.
 */
export function jevModeFor(point, env = process.env) {
  return parseJevEnv(point, env);
}

/**
 * Check if Jev is opted in for a point (shadow or active, not off).
 * Backward-compatible boolean API for existing callers.
 */
export function isJevShadowOptedIn(point, env = process.env) {
  return jevModeFor(point, env) !== 'off';
}

/**
 * Sweep and remove stale /tmp/omc-jev-* directories older than the given threshold.
 * Used for cleaning up leaked temp dirs from previous sessions.
 * Returns the count of successfully removed directories.
 */
export function sweepStaleTempDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
  const tmpDir = tmpdir();
  const now = Date.now();
  let cleaned = 0;
  
  try {
    const entries = readdirSync(tmpDir);
    for (const entry of entries) {
      if (!entry.startsWith('omc-jev-')) continue;
      
      const fullPath = join(tmpDir, entry);
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory() && (now - stats.mtimeMs > maxAgeMs)) {
          rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries that can't be stat'd or removed
      }
    }
  } catch {
    // If we can't read the tmp directory, skip the sweep
  }
  
  return cleaned;
}

/**
 * Fire-and-record one script-side judgment.
 * - Shadow mode: fire-and-forget, returns undefined immediately
 * - Active mode: waits (sync) for Jev answer, returns { mode, answer, source, ... }
 * - Off mode: returns undefined
 * Falls back to undefined (caller uses heuristic) on timeout/error/parse-failure.
 */
export function recordJevShadow({ point, state, questions, heuristic }) {
  const mode = jevModeFor(point);
  if (mode === 'off') return undefined;

  const tempDir = mkdtempSync(join(tmpdir(), 'omc-jev-'));
  const requestFile = join(tempDir, 'request.json');
  
  try {
    writeFileSync(requestFile, JSON.stringify({ point, state, questions, heuristic }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    
    if (mode === 'shadow') {
      // Fire-and-forget for shadow mode
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('../jev-resolve.mjs', import.meta.url)),
        '--request-file',
        requestFile,
      ], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: process.env,
      });
      child.on('error', () => {
        // Clean up temp dir on spawn error
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      });
      child.unref();
      return undefined;
    }
    
    // Active mode: spawn synchronously and read result
    if (mode === 'active') {
      try {
        const result = spawnSync(process.execPath, [
          fileURLToPath(new URL('../jev-resolve.mjs', import.meta.url)),
          '--request-file',
          requestFile,
        ], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          encoding: 'utf8',
          timeout: (parseInt(process.env.OMC_JEV_TIMEOUT_MS || '2000', 10) || 2000) + 500, // Add buffer
        });
        
        if (result.status === 0 && result.stdout) {
          try {
            return JSON.parse(result.stdout);
          } catch {
            // Parse error: fall back to heuristic
            return undefined;
          }
        }
      } finally {
        // Clean up temp dir after active mode (sync)
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // Jev logging is advisory; temp-file or spawn failures never affect hooks.
    // Clean up temp dir on any exception
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
  return undefined;
}
