import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../../features/auto-update.js', () => ({
  getSisyphusConfig: vi.fn(() => ({ silentAutoUpdate: false })),
}));

vi.mock('../../../features/context-injector/index.js', () => ({
  contextCollector: {
    register: vi.fn(),
    removeEntry: vi.fn(),
  },
}));

import {
  getBeadsInstructions,
  getBeadsContextConfig,
  registerBeadsContext,
  clearBeadsContext,
  BEADS_INSTRUCTIONS,
  BEADS_RUST_INSTRUCTIONS,
} from '../index.js';
import { getSisyphusConfig } from '../../../features/auto-update.js';
import { contextCollector } from '../../../features/context-injector/index.js';

const mockGetSisyphusConfig = vi.mocked(getSisyphusConfig);
const mockRegister = vi.mocked(contextCollector.register);
const mockRemoveEntry = vi.mocked(contextCollector.removeEntry);

describe('beads-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSisyphusConfig.mockReturnValue({ silentAutoUpdate: false });
  });

  describe('getBeadsInstructions', () => {
    it('should return beads instructions for beads tool', () => {
      const result = getBeadsInstructions('beads');
      expect(result).toBe(BEADS_INSTRUCTIONS);
      expect(result).toContain('bd');
      expect(result).toContain('Task Management: Beads');
    });

    it('should return beads-rust instructions for beads-rust tool', () => {
      const result = getBeadsInstructions('beads-rust');
      expect(result).toBe(BEADS_RUST_INSTRUCTIONS);
      expect(result).toContain('br');
      expect(result).toContain('Task Management: Beads-Rust');
    });
  });

  describe('getBeadsContextConfig', () => {
    it('should return defaults when no config', () => {
      mockGetSisyphusConfig.mockReturnValue({ silentAutoUpdate: false });
      const config = getBeadsContextConfig();
      expect(config).toEqual({
        taskTool: 'builtin',
        injectInstructions: true,
        useMcp: false,
      });
    });

    it('should read taskTool from config', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'beads',
      });
      const config = getBeadsContextConfig();
      expect(config.taskTool).toBe('beads');
    });

    it('should read taskToolConfig from config', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'beads-rust',
        taskToolConfig: {
          injectInstructions: false,
          useMcp: true,
        },
      });
      const config = getBeadsContextConfig();
      expect(config).toEqual({
        taskTool: 'beads-rust',
        injectInstructions: false,
        useMcp: true,
      });
    });
  });

  describe('registerBeadsContext', () => {
    it('should return false when taskTool is builtin', () => {
      mockGetSisyphusConfig.mockReturnValue({ silentAutoUpdate: false });
      const result = registerBeadsContext('session-1');
      expect(result).toBe(false);
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('should return false when injectInstructions is false', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'beads',
        taskToolConfig: { injectInstructions: false },
      });
      const result = registerBeadsContext('session-1');
      expect(result).toBe(false);
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('should register context for beads tool', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'beads',
      });
      const result = registerBeadsContext('session-1');
      expect(result).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith('session-1', {
        id: 'beads-instructions',
        source: 'beads',
        content: BEADS_INSTRUCTIONS,
        priority: 'normal',
      });
    });

    it('should register context for beads-rust tool', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'beads-rust',
      });
      const result = registerBeadsContext('session-2');
      expect(result).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith('session-2', {
        id: 'beads-instructions',
        source: 'beads',
        content: BEADS_RUST_INSTRUCTIONS,
        priority: 'normal',
      });
    });

    it('should return false for invalid taskTool value', () => {
      mockGetSisyphusConfig.mockReturnValue({
        silentAutoUpdate: false,
        taskTool: 'invalid-tool' as any,
      });
      const result = registerBeadsContext('session-1');
      expect(result).toBe(false);
      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  describe('clearBeadsContext', () => {
    it('should remove beads entry from collector', () => {
      clearBeadsContext('session-1');
      expect(mockRemoveEntry).toHaveBeenCalledWith('session-1', 'beads', 'beads-instructions');
    });
  });

  describe('constants', () => {
    it('BEADS_INSTRUCTIONS should contain beads CLI commands', () => {
      expect(BEADS_INSTRUCTIONS).toContain('bd create');
      expect(BEADS_INSTRUCTIONS).toContain('bd list');
      expect(BEADS_INSTRUCTIONS).toContain('bd show');
      expect(BEADS_INSTRUCTIONS).toContain('bd update');
      expect(BEADS_INSTRUCTIONS).toContain('bd deps');
    });

    it('BEADS_RUST_INSTRUCTIONS should contain beads-rust CLI commands', () => {
      expect(BEADS_RUST_INSTRUCTIONS).toContain('br create');
      expect(BEADS_RUST_INSTRUCTIONS).toContain('br list');
      expect(BEADS_RUST_INSTRUCTIONS).toContain('br show');
      expect(BEADS_RUST_INSTRUCTIONS).toContain('br update');
      expect(BEADS_RUST_INSTRUCTIONS).toContain('br deps');
    });
  });
});
