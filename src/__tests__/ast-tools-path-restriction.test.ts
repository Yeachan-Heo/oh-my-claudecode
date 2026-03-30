import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'path';
import { validateToolPath } from '../tools/ast-tools.js';

describe('validateToolPath', () => {
  const originalEnv = process.env.OMC_RESTRICT_TOOL_PATHS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OMC_RESTRICT_TOOL_PATHS;
    } else {
      process.env.OMC_RESTRICT_TOOL_PATHS = originalEnv;
    }
    vi.restoreAllMocks();
  });

  describe('when OMC_RESTRICT_TOOL_PATHS is not set', () => {
    beforeEach(() => {
      delete process.env.OMC_RESTRICT_TOOL_PATHS;
    });

    it('allows any path without restriction', () => {
      const result = validateToolPath('/etc/passwd');
      expect(result).toBe(resolve('/etc/passwd'));
    });

    it('allows relative paths', () => {
      const result = validateToolPath('.');
      expect(result).toBe(resolve('.'));
    });
  });

  describe('when OMC_RESTRICT_TOOL_PATHS=false', () => {
    beforeEach(() => {
      process.env.OMC_RESTRICT_TOOL_PATHS = 'false';
    });

    it('allows any path', () => {
      const result = validateToolPath('/tmp/outside');
      expect(result).toBe(resolve('/tmp/outside'));
    });
  });

  describe('when OMC_RESTRICT_TOOL_PATHS=true', () => {
    beforeEach(() => {
      process.env.OMC_RESTRICT_TOOL_PATHS = 'true';
    });

    it('allows paths within project root', () => {
      const result = validateToolPath('.');
      expect(result).toBe(resolve('.'));
    });

    it('allows subdirectory paths', () => {
      const result = validateToolPath('src');
      expect(result).toBe(resolve('src'));
    });

    it('rejects absolute paths outside project root', () => {
      expect(() => validateToolPath('/etc/passwd')).toThrow('Path restricted');
    });

    it('rejects paths that traverse above project root', () => {
      expect(() => validateToolPath('../../.ssh/id_rsa')).toThrow('Path restricted');
    });

    it('rejects home directory paths', () => {
      expect(() => validateToolPath('/Users/someone/.ssh')).toThrow('Path restricted');
    });

    it('includes helpful message in error', () => {
      expect(() => validateToolPath('/etc')).toThrow('OMC_RESTRICT_TOOL_PATHS=false');
    });
  });
});
