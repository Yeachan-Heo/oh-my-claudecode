/**
 * OMC HUD - API Key Source Element Tests
 *
 * Tests for detecting and rendering the ANTHROPIC_API_KEY source.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectApiKeySource, renderApiKeySource } from '../hud/elements/api-key-source.js';
import type { ApiKeySource } from '../hud/elements/api-key-source.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock paths utility
vi.mock('../utils/paths.js', () => ({
  getClaudeConfigDir: vi.fn(() => '/home/user/.claude'),
}));

import { existsSync, readFileSync } from 'fs';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('API Key Source Element', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  describe('detectApiKeySource', () => {
    it('should return "project" when key is in project settings', () => {
      mockedExistsSync.mockImplementation((path) =>
        String(path) === '/my/project/.claude/settings.local.json'
      );
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } })
      );

      expect(detectApiKeySource('/my/project')).toBe('project');
    });

    it('should return "global" when key is in global settings', () => {
      mockedExistsSync.mockImplementation((path) =>
        String(path) === '/home/user/.claude/settings.json'
      );
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } })
      );

      expect(detectApiKeySource('/my/project')).toBe('global');
    });

    it('should return "env" when key is only in environment', () => {
      mockedExistsSync.mockReturnValue(false);
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

      expect(detectApiKeySource('/my/project')).toBe('env');
    });

    it('should return null when no key is found anywhere', () => {
      mockedExistsSync.mockReturnValue(false);

      expect(detectApiKeySource('/my/project')).toBeNull();
    });

    it('should prioritize project over global', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } })
      );

      expect(detectApiKeySource('/my/project')).toBe('project');
    });

    it('should prioritize global over env', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
      mockedExistsSync.mockImplementation((path) =>
        String(path) === '/home/user/.claude/settings.json'
      );
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } })
      );

      expect(detectApiKeySource('/my/project')).toBe('global');
    });

    it('should handle malformed JSON gracefully', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('not valid json');
      process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

      expect(detectApiKeySource('/my/project')).toBe('env');
    });

    it('should handle settings without env block', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify({ someOtherKey: true }));

      expect(detectApiKeySource('/my/project')).toBeNull();
    });

    it('should handle null cwd', () => {
      mockedExistsSync.mockImplementation((path) =>
        String(path) === '/home/user/.claude/settings.json'
      );
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } })
      );

      expect(detectApiKeySource()).toBe('global');
    });
  });

  describe('renderApiKeySource', () => {
    it('should return null for null source', () => {
      expect(renderApiKeySource(null)).toBeNull();
    });

    it('should render "project" source', () => {
      const result = renderApiKeySource('project');
      expect(result).not.toBeNull();
      expect(result).toContain('key:');
      expect(result).toContain('project');
    });

    it('should render "global" source', () => {
      const result = renderApiKeySource('global');
      expect(result).not.toBeNull();
      expect(result).toContain('key:');
      expect(result).toContain('global');
    });

    it('should render "env" source', () => {
      const result = renderApiKeySource('env');
      expect(result).not.toBeNull();
      expect(result).toContain('key:');
      expect(result).toContain('env');
    });

    it('should render all valid sources without errors', () => {
      const sources: ApiKeySource[] = ['project', 'global', 'env'];
      for (const source of sources) {
        expect(() => renderApiKeySource(source)).not.toThrow();
      }
    });
  });
});
