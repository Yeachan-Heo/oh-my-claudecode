import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { projectMemoryWriteTool } from '../memory-tools.js';

const TEST_DIR = '/tmp/memory-tools-test';

// Mock validateWorkingDirectory to allow test directory
vi.mock('../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual('../../lib/worktree-paths.js');
  return {
    ...actual,
    validateWorkingDirectory: vi.fn((workingDirectory?: string) => {
      return workingDirectory || process.cwd();
    }),
  };
});

describe('memory-tools payload validation', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should accept large memory payloads', async () => {
    const result = await projectMemoryWriteTool.handler({
      memory: { huge: 'x'.repeat(2_000_000) },
      workingDirectory: TEST_DIR,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Successfully');
  });

  it('should accept deeply nested memory payloads', async () => {
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }

    const result = await projectMemoryWriteTool.handler({
      memory: obj,
      workingDirectory: TEST_DIR,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Successfully');
  });

  it('should accept memory with many top-level keys', async () => {
    const memory: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      memory[`key_${i}`] = 'value';
    }

    const result = await projectMemoryWriteTool.handler({
      memory,
      workingDirectory: TEST_DIR,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Successfully');
  });

  it('should allow normal-sized memory writes', async () => {
    const result = await projectMemoryWriteTool.handler({
      memory: {
        version: '1.0.0',
        techStack: { language: 'TypeScript', framework: 'Node.js' },
      },
      workingDirectory: TEST_DIR,
    });

    expect(result.content[0].text).toContain('Successfully');
  });
});
