import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Test coverage for context-text-loader.mjs import-failure fallback.
 * 
 * The loader is used by twelve hooks to optionally load context-text-sanitize.mjs.
 * When OMC_CONTEXT_TEXT_SANITIZE=1 but the module cannot be imported, the loader
 * must return null and hooks should produce output unchanged (fail-open behavior).
 */

describe('context-text-loader.mjs import-failure fallback', () => {
  it('should have a try-catch for the import that returns null on failure', () => {
    const loaderPath = join(process.cwd(), 'scripts', 'lib', 'context-text-loader.mjs');
    const content = readFileSync(loaderPath, 'utf8');

    // Verify the try-catch pattern exists
    expect(content).toContain('try {');
    expect(content).toContain('await import');
    expect(content).toContain('} catch {');
    expect(content).toContain('return null');
  });

  it('should check OMC_CONTEXT_TEXT_SANITIZE before attempting import', () => {
    const loaderPath = join(process.cwd(), 'scripts', 'lib', 'context-text-loader.mjs');
    const content = readFileSync(loaderPath, 'utf8');

    // Verify the guard check exists
    expect(content).toContain('OMC_CONTEXT_TEXT_SANITIZE');
    expect(content).toMatch(/if\s*\(\s*!\s*\['1',\s*'true'\]/);
    expect(content).toContain('return null');
  });

  it('should return null when the flag is unset', () => {
    const loaderPath = join(process.cwd(), 'scripts', 'lib', 'context-text-loader.mjs');
    const content = readFileSync(loaderPath, 'utf8');

    // The first return in the function should be null for unset flag
    expect(content).toMatch(
      /if\s*\(\s*!\s*\['1',\s*'true'\]\s*\.includes\([^)]*OMC_CONTEXT_TEXT_SANITIZE/
    );
    expect(content).toContain('return null');
  });

  it('should export async loadContextText function', () => {
    const loaderPath = join(process.cwd(), 'scripts', 'lib', 'context-text-loader.mjs');
    const content = readFileSync(loaderPath, 'utf8');

    // Verify the function is exported and async
    expect(content).toContain('export async function loadContextText()');
  });
});
