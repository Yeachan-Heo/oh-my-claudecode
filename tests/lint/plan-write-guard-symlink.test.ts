import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, lstatSync, realpathSync } from 'fs';
import { resolve, relative, dirname, sep, isAbsolute, join } from 'path';
import os from 'os';

/**
 * Regression test for issue #5085: symlink traversal bypass in plan-write guard.
 * 
 * The guard validates that writes stay within .omc/plans/ but was vulnerable to
 * attacks using symlinks with '..' traversal (e.g. 'link/../victim.md' where
 * 'link' -> '/tmp/out'). The filesystem kernel follows symlinks before processing '..',
 * allowing escape when the guard used only lexical path normalization.
 */

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realPathInside(path: string, base: string): boolean {
  try {
    const rel = relative(base, realpathSync(path));
    return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Validation function matching the fixed code in pre-tool-enforcer.mjs
 */
function pathWithSymlinksStaysInside(filePath: string, base: string): boolean {
  try {
    // Convert to absolute path for consistent comparison
    const target = resolve(base, filePath);
    // Find the nearest existing directory and check if the unresolved path stays inside
    let ancestor = dirname(target);
    while (!pathExists(ancestor)) ancestor = dirname(ancestor);
    // The ancestor must be inside the bounds
    if (!realPathInside(ancestor, base)) return false;
    // Now check for symlink-based escapes in the path components.
    // Walk the input path and follow symlinks to verify no component
    // escapes the bounds. This catches cases where following symlinks and then '..' escape.
    const components = filePath.split(sep).filter(c => c && c !== '.');
    let current = base;
    for (const comp of components) {
      if (comp === '..') {
        // Check if going up stays inside
        const parent = dirname(current);
        if (!realPathInside(parent, base)) return false;
        current = parent;
      } else if (comp) {
        const next = resolve(current, comp);
        // If the component exists and is a symlink, verify its target stays inside
        if (pathExists(next)) {
          try {
            const realNext = realpathSync(next);
            // Following this symlink must not escape
            if (!realPathInside(realNext, base)) return false;
            current = realNext;
          } catch {
            // Treat resolution errors as rejections
            return false;
          }
        } else {
          // Component doesn't exist; continue with lexical path
          current = next;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

describe('plan-write-guard symlink validation', () => {
  let testDir: string;
  let plansDir: string;
  let outsideDir: string;

  beforeEach(() => {
    testDir = join(os.tmpdir(), `plan-write-guard-test-${Date.now()}`);
    plansDir = join(testDir, '.omc', 'plans');
    outsideDir = join(testDir, 'outside', 'target');
    mkdirSync(plansDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    if (pathExists(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should allow normal files within plans directory', () => {
    const realPlansDir = realpathSync(plansDir);
    expect(pathWithSymlinksStaysInside('test.md', realPlansDir)).toBe(true);
    expect(pathWithSymlinksStaysInside('subdir/test.md', realPlansDir)).toBe(true);
  });

  it('should reject paths with .. that try to escape', () => {
    const realPlansDir = realpathSync(plansDir);
    // Try to escape to parent of plans
    expect(pathWithSymlinksStaysInside('../escape.md', realPlansDir)).toBe(false);
    // Try to escape multiple levels
    expect(pathWithSymlinksStaysInside('../../escape.md', realPlansDir)).toBe(false);
  });

  it('should reject symlink-based traversal escapes (issue #5085)', () => {
    // Create a symlink from plans/link pointing outside
    const linkPath = join(plansDir, 'link');
    symlinkSync(outsideDir, linkPath);

    const realPlansDir = realpathSync(plansDir);

    // This should be rejected: following 'link' goes to outsideDir,
    // then '..' goes up one more level, escaping the bounds
    expect(pathWithSymlinksStaysInside('link/../victim.md', realPlansDir)).toBe(false);

    // Multiple levels of escape via symlink
    expect(pathWithSymlinksStaysInside('link/../../etc/passwd', realPlansDir)).toBe(false);
  });

  it('should handle nested symlink chains', () => {
    // Create a chain of symlinks that try to escape
    const link1 = join(plansDir, 'link1');
    const intermediateDir = join(testDir, 'intermediate');
    mkdirSync(intermediateDir, { recursive: true });
    symlinkSync(intermediateDir, link1);

    // Link intermediate to outside
    const link2 = join(intermediateDir, 'link2');
    symlinkSync(outsideDir, link2);

    const realPlansDir = realpathSync(plansDir);

    // Chain escape attempt
    expect(pathWithSymlinksStaysInside('link1/link2/../victim.md', realPlansDir)).toBe(false);
  });

  it('should allow simple paths without symlinks', () => {
    const realPlansDir = realpathSync(plansDir);
    // Simple paths without symlinks should pass
    expect(pathWithSymlinksStaysInside('file.md', realPlansDir)).toBe(true);
    expect(pathWithSymlinksStaysInside('nested/file.md', realPlansDir)).toBe(true);
  });

  it('should reject absolute paths', () => {
    const realPlansDir = realpathSync(plansDir);
    expect(pathWithSymlinksStaysInside('/etc/passwd', realPlansDir)).toBe(false);
    expect(pathWithSymlinksStaysInside(join(outsideDir, 'victim.md'), realPlansDir)).toBe(false);
  });
});
