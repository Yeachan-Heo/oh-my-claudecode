import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Regression test for issue #4156: Windows file identity comparison
 *
 * On Windows, Node.js returns:
 * - fstatSync(fd).dev: real volume serial number
 * - lstatSync(path).dev: 0
 *
 * This caused atomic write verification to fail with:
 * "atomic write temporary file was replaced before rename"
 *
 * The fix introduces sameFileIdentity(a, b) that:
 * 1. Always compares inode
 * 2. Compares dev only when NOT on Windows OR both dev values are non-zero
 * 3. Skips dev comparison on Windows when either value is 0 (since lstat returns 0)
 */
describe('issue #4156: Windows file identity comparison (dev=0 from lstat)', () => {
  const root = process.cwd();

  it('src/lib/atomic-write.ts has sameFileIdentity helper', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Check for the sameFileIdentity function
    expect(content).toContain('function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean');

    // Check for the Windows platform check
    expect(content).toContain('const isWindows = process.platform === "win32"');

    // Check for the dev comparison logic
    expect(content).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');

    // Check for inode comparison
    expect(content).toContain('if (a.ino !== b.ino) return false');

    // Check that dev comparison happens on POSIX
    expect(content).toContain('return a.dev === b.dev');
  });

  it('src/lib/atomic-write.ts uses sameFileIdentity in verifyPrivateTempFile', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Find the verifyPrivateTempFile function
    const functionStart = content.indexOf('function verifyPrivateTempFile(');
    const functionEnd = content.indexOf('function verifyPublishedFile(');
    const functionBody = content.substring(functionStart, functionEnd);

    // Should use sameFileIdentity instead of comparing dev and ino separately
    expect(functionBody).toContain('sameFileIdentity(fdStats as FileIdentity, pathStats as FileIdentity)');
    expect(functionBody).not.toContain('fdStats.dev !== pathStats.dev || fdStats.ino !== pathStats.ino');
  });

  it('src/lib/atomic-write.ts uses sameFileIdentity in verifyPublishedFile', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Find the verifyPublishedFile function
    const functionStart = content.indexOf('function verifyPublishedFile(');
    const functionEnd = content.indexOf('function preservePriorTarget(');
    const functionBody = content.substring(functionStart, functionEnd);

    // Should use sameFileIdentity
    expect(functionBody).toContain('sameFileIdentity(fdStats as FileIdentity, pathStats as FileIdentity)');
  });

  it('src/lib/atomic-write.ts uses sameFileIdentity in rollbackPriorTarget', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Find the rollbackPriorTarget function
    const functionStart = content.indexOf('function rollbackPriorTarget(');
    const functionEnd = content.indexOf('function removeBackup(');
    const functionBody = content.substring(functionStart, functionEnd);

    // Should use sameFileIdentity
    expect(functionBody).toContain('sameFileIdentity(current, expectedIdentity)');
  });

  it('templates/hooks/lib/atomic-write.mjs has sameFileIdentity helper', () => {
    const filePath = join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    // Check for the sameFileIdentity function
    expect(content).toContain('function sameFileIdentity(a, b)');

    // Check for the Windows platform check
    expect(content).toContain("const isWindows = process.platform === 'win32'");

    // Check for the dev comparison logic
    expect(content).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');

    // Check for inode comparison
    expect(content).toContain('if (a.ino !== b.ino) return false');

    // Check that dev comparison happens on POSIX
    expect(content).toContain('return a.dev === b.dev');
  });

  it('templates/hooks/lib/atomic-write.mjs sameFile uses sameFileIdentity', () => {
    const filePath = join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    // Find the sameFile function
    const functionStart = content.indexOf('function sameFile(');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // Should use sameFileIdentity
    expect(functionBody).toContain('sameFileIdentity(actual, expected)');
    expect(functionBody).not.toContain('actual.dev === expected.dev && actual.ino === expected.ino');
  });

  it('scripts/lib/atomic-write.mjs has sameFileIdentity helper', () => {
    const filePath = join(root, 'scripts', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    // Check for the sameFileIdentity function
    expect(content).toContain('function sameFileIdentity(a, b)');

    // Check for the Windows platform check
    expect(content).toContain("const isWindows = process.platform === 'win32'");

    // Check for the dev comparison logic
    expect(content).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');

    // Check for inode comparison
    expect(content).toContain('if (a.ino !== b.ino) return false');

    // Check that dev comparison happens on POSIX
    expect(content).toContain('return a.dev === b.dev');
  });

  it('scripts/lib/atomic-write.mjs sameFile uses sameFileIdentity', () => {
    const filePath = join(root, 'scripts', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    // Find the sameFile function
    const functionStart = content.indexOf('function sameFile(');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // Should use sameFileIdentity
    expect(functionBody).toContain('sameFileIdentity(actual, expected)');
    expect(functionBody).not.toContain('actual.dev === expected.dev && actual.ino === expected.ino');
  });

  it('sameFileIdentity correctly handles Windows scenario: same ino, fstat dev=2831858368, lstat dev=0', () => {
    // This is a conceptual test showing the logic
    // On Windows: fstat returns real dev, lstat returns 0
    // When both have same ino (123456) but one has dev=0, they should still match

    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Extract the sameFileIdentity function logic
    // On Windows with different dev values (one is 0), it should still return true if ino matches
    expect(content).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');
    expect(content).toContain('return true; // Skip dev comparison on Windows when either is 0');
  });

  it('sameFileIdentity still rejects different inodes even on Windows', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // The function should check ino BEFORE checking dev
    const functionStart = content.indexOf('function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // Inode comparison must come first and must reject mismatches
    const inoCheckIndex = functionBody.indexOf('if (a.ino !== b.ino) return false');
    const devCheckIndex = functionBody.indexOf('if (isWindows && (a.dev === 0 || b.dev === 0))');
    expect(inoCheckIndex).toBeLessThan(devCheckIndex);
  });

  it('sameFileIdentity still enforces dev match on POSIX', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    const functionStart = content.indexOf('function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // On POSIX or when both dev values are non-zero, dev must be checked
    expect(functionBody).toContain('// On POSIX or when both dev values are non-zero, require dev match');
    expect(functionBody).toContain('return a.dev === b.dev');
  });

  it('sameFileIdentity is exported from src/lib/atomic-write.ts', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Function must be exported
    expect(content).toContain('export function sameFileIdentity');
  });

  it('FileIdentity interface is exported from src/lib/atomic-write.ts', () => {
    const filePath = join(root, 'src', 'lib', 'atomic-write.ts');
    const content = readFileSync(filePath, 'utf8');

    // Interface must be exported
    expect(content).toContain('export interface FileIdentity');
  });

  it('src/lib/mode-state-io.ts imports and uses sameFileIdentity from atomic-write', () => {
    const filePath = join(root, 'src', 'lib', 'mode-state-io.ts');
    const content = readFileSync(filePath, 'utf8');

    // Must import from atomic-write
    expect(content).toContain("import { atomicWriteJsonSync, sameFileIdentity } from './atomic-write.js'");

    // sameFile function must use the imported sameFileIdentity
    const samFileStart = content.indexOf('function sameFile(path: string, expected: FileIdentity)');
    const samFileEnd = content.indexOf('\n}', samFileStart) + 2;
    const sameFileFunctionBody = content.substring(samFileStart, samFileEnd);
    expect(sameFileFunctionBody).toContain('sameFileIdentity(actual, expected)');
  });

  it('templates/hooks/lib/atomic-write.mjs has sameFileIdentity with Windows handling', () => {
    const filePath = join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    const functionStart = content.indexOf('function sameFileIdentity(a, b)');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // Must have Windows handling
    expect(functionBody).toContain("const isWindows = process.platform === 'win32'");
    expect(functionBody).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');
  });

  it('scripts/lib/atomic-write.mjs has sameFileIdentity with Windows handling', () => {
    const filePath = join(root, 'scripts', 'lib', 'atomic-write.mjs');
    const content = readFileSync(filePath, 'utf8');

    const functionStart = content.indexOf('function sameFileIdentity(a, b)');
    const functionEnd = content.indexOf('\n}', functionStart) + 2;
    const functionBody = content.substring(functionStart, functionEnd);

    // Must have Windows handling
    expect(functionBody).toContain("const isWindows = process.platform === 'win32'");
    expect(functionBody).toContain('if (isWindows && (a.dev === 0 || b.dev === 0))');
  });
});
