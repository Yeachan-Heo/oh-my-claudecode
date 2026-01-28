/**
 * Tests for Ralph-Fresh CLI Command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ralphFreshCommand } from '../ralph-fresh.js';
import * as child_process from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

describe('Ralph-Fresh CLI Command', () => {
  let testDir: string;
  let originalCwd: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ralph-fresh-cli-test-'));
    originalCwd = process.cwd();
    process.chdir(testDir);

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    }) as any;

    // Reset spawn mock
    vi.mocked(child_process.spawn).mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Mutual Exclusion', () => {
    it('should exit if standard ralph is active', async () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Create standard ralph state
      const stateFile = join(stateDir, 'ralph-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));

      await expect(async () => {
        await ralphFreshCommand('Build a feature', {});
      }).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Standard Ralph is currently active')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ralph and Ralph-Fresh are mutually exclusive')
      );
    });

    it('should exit if autopilot is active', async () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Create autopilot state
      const stateFile = join(stateDir, 'autopilot-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));

      await expect(async () => {
        await ralphFreshCommand('Build a feature', {});
      }).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Autopilot is currently active')
      );
    });

    it('should exit if ultrapilot is active', async () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Create ultrapilot state
      const stateFile = join(stateDir, 'ultrapilot-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));

      await expect(async () => {
        await ralphFreshCommand('Build a feature', {});
      }).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ultrapilot is currently active')
      );
    });

    it('should exit if swarm is active', async () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Create swarm marker
      const markerFile = join(stateDir, 'swarm-active.marker');
      writeFileSync(markerFile, JSON.stringify({ startedAt: new Date().toISOString() }));

      await expect(async () => {
        await ralphFreshCommand('Build a feature', {});
      }).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Swarm is currently active')
      );
    });

    it('should exit if pipeline is active', async () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Create pipeline state
      const stateFile = join(stateDir, 'pipeline-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));

      await expect(async () => {
        await ralphFreshCommand('Build a feature', {});
      }).rejects.toThrow('process.exit(1)');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pipeline is currently active')
      );
    });
  });

  describe('JSON Output Mode', () => {
    it('should output JSON when json option is true', async () => {
      await ralphFreshCommand('Build a feature', { json: true });

      // Should have called console.log with JSON
      const jsonOutput = consoleLogSpy.mock.calls.find((call: any) => {
        const arg = call[0];
        return typeof arg === 'string' && arg.includes('"mode"');
      });

      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput![0] as string);
      expect(parsed.mode).toBe('ralph-fresh');
      expect(parsed.prompt).toBe('Build a feature');
      expect(parsed.options.maxIterations).toBe(20);
      expect(parsed.options.prd).toBe(false);
      expect(parsed.options.verbose).toBe(false);
    });

    it('should include custom options in JSON output', async () => {
      await ralphFreshCommand('Build a feature', {
        json: true,
        maxIterations: 15,
        prd: true,
        verbose: true
      });

      const jsonOutput = consoleLogSpy.mock.calls.find((call: any) => {
        const arg = call[0];
        return typeof arg === 'string' && arg.includes('"mode"');
      });

      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput![0] as string);
      expect(parsed.options.maxIterations).toBe(15);
      expect(parsed.options.prd).toBe(true);
      expect(parsed.options.verbose).toBe(true);
    });

    it('should not spawn process in JSON mode', async () => {
      await ralphFreshCommand('Build a feature', { json: true });

      expect(child_process.spawn).not.toHaveBeenCalled();
    });
  });

  describe('Script Execution', () => {
    it('should spawn the orchestrator script with correct arguments', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            // Simulate successful exit
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const promise = ralphFreshCommand('Build a feature', {});

      // Wait for the async operation
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnCall = mockSpawn.mock.calls[0];

      // Check command (tsx or node)
      expect(['tsx', 'node']).toContain(spawnCall[0]);

      // Check arguments include the script path and prompt
      const args = spawnCall[1] as string[];
      expect(args.some(arg => arg.includes('ralph-fresh'))).toBe(true);
      expect(args).toContain('Build a feature');
    });

    it('should pass maxIterations option to script', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      ralphFreshCommand('Build a feature', { maxIterations: 15 });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSpawn).toHaveBeenCalled();
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--max-iterations');
      expect(args).toContain('15');
    });

    it('should pass verbose flag to script', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      ralphFreshCommand('Build a feature', { verbose: true });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSpawn).toHaveBeenCalled();
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--verbose');
    });

    it('should pass prd flag to script', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      ralphFreshCommand('Build a feature', { prd: true });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSpawn).toHaveBeenCalled();
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--prd');
    });

    it('should use stdio inherit to stream output', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      ralphFreshCommand('Build a feature', {});

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSpawn).toHaveBeenCalled();
      const options = mockSpawn.mock.calls[0][2];
      expect(options).toHaveProperty('stdio', 'inherit');
    });

    it('should exit with spawned process exit code on non-zero exit', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const mockProcess = {
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'exit') {
            // Call exit handler synchronously to avoid timing issues
            callback(42);
          }
          return mockProcess;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      // Execute the command - it should throw due to process.exit mock
      try {
        await ralphFreshCommand('Build a feature', {});
      } catch (error: any) {
        // Expected to throw
        expect(error.message).toContain('process.exit(42)');
      }

      // The process.exit(42) should have been called
      expect(processExitSpy).toHaveBeenCalledWith(42);
    });
  });
});
