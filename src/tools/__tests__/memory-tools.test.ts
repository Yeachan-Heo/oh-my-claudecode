import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { projectMemoryWriteTool } from '../memory-tools.js';
import { getProjectIdentifier } from '../../lib/worktree-paths.js';

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
    delete process.env.OMC_STATE_DIR;
    mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
  });

  afterEach(() => {
    delete process.env.OMC_STATE_DIR;
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

  it('should write to centralized project memory without creating a local file when OMC_STATE_DIR is set', async () => {
    const stateDir = '/tmp/memory-tools-centralized-state';
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    rmSync(join(TEST_DIR, '.omc'), { recursive: true, force: true });

    try {
      process.env.OMC_STATE_DIR = stateDir;

      const result = await projectMemoryWriteTool.handler({
        memory: {
          version: '1.0.0',
          projectRoot: TEST_DIR,
          techStack: { language: 'TypeScript' },
        },
        workingDirectory: TEST_DIR,
      });

      const centralizedPath = join(stateDir, getProjectIdentifier(TEST_DIR), 'project-memory.json');

      expect(result.content[0].text).toContain(centralizedPath);
      expect(JSON.parse(readFileSync(centralizedPath, 'utf-8')).projectRoot).toBe(TEST_DIR);
      expect(existsSync(join(TEST_DIR, '.omc', 'project-memory.json'))).toBe(false);
      expect(result.isError).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
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
