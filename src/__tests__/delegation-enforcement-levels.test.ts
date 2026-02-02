/**
 * Comprehensive tests for delegation enforcement hook implementation
 *
 * Tests: suggestAgentForFile, getEnforcementLevel (via processOrchestratorPreTool),
 * processOrchestratorPreTool enforcement levels, AuditEntry interface, and
 * processPreToolUse integration in bridge.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processOrchestratorPreTool,
  isAllowedPath,
  isSourceFile,
  isWriteEditTool,
  clearEnforcementCache,
  type ToolExecuteInput,
} from '../hooks/omc-orchestrator/index.js';
import type { AuditEntry } from '../hooks/omc-orchestrator/audit.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

// Mock os module
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
  };
});

// Mock boulder-state to avoid side effects
vi.mock('../features/boulder-state/index.js', () => ({
  readBoulderState: vi.fn(() => null),
  getPlanProgress: vi.fn(() => ({ total: 0, completed: 0, isComplete: true })),
}));

// Mock notepad to avoid side effects
vi.mock('../hooks/notepad/index.js', () => ({
  addWorkingMemoryEntry: vi.fn(),
  setPriorityContext: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('delegation-enforcement-levels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnforcementCache();
    // Default: no config files exist
    mockExistsSync.mockReturnValue(false);
  });

  // ─── 1. suggestAgentForFile (tested indirectly via warning messages) ───

  describe('suggestAgentForFile via warning messages', () => {
    // Helper: trigger a warn-level enforcement on a file and check agent suggestion in message
    function getWarningForFile(filename: string): string | undefined {
      mockExistsSync.mockReturnValue(false); // default warn
      const result = processOrchestratorPreTool({
        toolName: 'Write',
        toolInput: { filePath: `src/${filename}` },
        directory: '/tmp/test-project',
      });
      return result.message;
    }

    const extensionToAgent: [string, string][] = [
      ['file.ts', 'executor-low (simple) or executor (complex)'],
      ['file.tsx', 'designer-low (simple) or designer (complex UI)'],
      ['file.js', 'executor-low'],
      ['file.jsx', 'designer-low'],
      ['file.py', 'executor-low (simple) or executor (complex)'],
      ['file.vue', 'designer'],
      ['file.svelte', 'designer'],
      ['file.css', 'designer-low'],
      ['file.scss', 'designer-low'],
      ['file.md', 'writer (documentation)'],
      ['file.json', 'executor-low'],
    ];

    it.each(extensionToAgent)(
      'suggests correct agent for %s',
      (filename, expectedAgent) => {
        const msg = getWarningForFile(filename);
        expect(msg).toBeDefined();
        expect(msg).toContain(`Suggested agent: ${expectedAgent}`);
      }
    );

    it('falls back to executor for unknown extension', () => {
      const msg = getWarningForFile('file.xyz');
      // .xyz is not in WARNED_EXTENSIONS, so isSourceFile returns false
      // but it's also not an allowed path, so it still gets warned
      // The suggestion should be 'executor' (the fallback)
      expect(msg).toBeDefined();
      expect(msg).toContain('Suggested agent: executor');
    });

    it('handles empty path by allowing it (no warning)', () => {
      const result = processOrchestratorPreTool({
        toolName: 'Write',
        toolInput: { filePath: '' },
        directory: '/tmp/test-project',
      });
      // Empty path -> isAllowedPath returns true -> no warning
      expect(result.continue).toBe(true);
      expect(result.message).toBeUndefined();
    });
  });

  // ─── 2. getEnforcementLevel (via processOrchestratorPreTool behavior) ───

  describe('getEnforcementLevel via processOrchestratorPreTool', () => {
    const sourceFileInput: ToolExecuteInput = {
      toolName: 'Write',
      toolInput: { filePath: 'src/app.ts' },
      directory: '/tmp/test-project',
    };

    it('defaults to warn when no config file exists', () => {
      mockExistsSync.mockReturnValue(false);
      const result = processOrchestratorPreTool(sourceFileInput);
      // warn = continue: true with message
      expect(result.continue).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message).toContain('DELEGATION REQUIRED');
    });

    it('local config overrides global config', () => {
      // Local config exists with 'off', global has 'strict'
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]tmp[\\/]test-project[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        if (/[\\/]mock[\\/]home[\\/]\.claude[\\/]\.omc-config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]tmp[\\/]test-project[\\/]\.omc[\\/]config\.json$/.test(s)) {
          return JSON.stringify({ delegationEnforcementLevel: 'off' });
        }
        if (/[\\/]mock[\\/]home[\\/]\.claude[\\/]\.omc-config\.json$/.test(s)) {
          return JSON.stringify({ delegationEnforcementLevel: 'strict' });
        }
        return '';
      });

      const result = processOrchestratorPreTool(sourceFileInput);
      // 'off' means early exit, continue with no message
      expect(result.continue).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it('falls back to global config when no local config', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]mock[\\/]home[\\/]\.claude[\\/]\.omc-config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]mock[\\/]home[\\/]\.claude[\\/]\.omc-config\.json$/.test(s)) {
          return JSON.stringify({ delegationEnforcementLevel: 'strict' });
        }
        return '';
      });

      const result = processOrchestratorPreTool(sourceFileInput);
      // strict = blocked
      expect(result.continue).toBe(false);
      expect(result.reason).toBe('DELEGATION_REQUIRED');
    });

    it('falls back to warn on invalid enforcement level in config', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]tmp[\\/]test-project[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ delegationEnforcementLevel: 'invalid-value' });
      });

      const result = processOrchestratorPreTool(sourceFileInput);
      // Should fall back to 'warn'
      expect(result.continue).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('falls back to warn on malformed JSON config', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]tmp[\\/]test-project[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return 'not valid json {{{';
      });

      const result = processOrchestratorPreTool(sourceFileInput);
      // Malformed JSON -> catch block -> continue to next config -> default warn
      expect(result.continue).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('supports enforcementLevel key as alternative', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]tmp[\\/]test-project[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ enforcementLevel: 'strict' });
      });

      const result = processOrchestratorPreTool(sourceFileInput);
      expect(result.continue).toBe(false);
      expect(result.reason).toBe('DELEGATION_REQUIRED');
    });
  });

  // ─── 3. processOrchestratorPreTool enforcement levels ───

  describe('processOrchestratorPreTool enforcement levels', () => {
    function setEnforcement(level: string) {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ delegationEnforcementLevel: level });
      });
    }

    describe('enforcement=off', () => {
      it('write to source file continues with no message', () => {
        setEnforcement('off');
        const result = processOrchestratorPreTool({
          toolName: 'Write',
          toolInput: { filePath: 'src/app.ts' },
          directory: '/tmp/test-project',
        });
        expect(result.continue).toBe(true);
        expect(result.message).toBeUndefined();
        expect(result.reason).toBeUndefined();
      });
    });

    describe('enforcement=warn', () => {
      it('write to source file continues with warning message and agent suggestion', () => {
        setEnforcement('warn');
        const result = processOrchestratorPreTool({
          toolName: 'Write',
          toolInput: { filePath: 'src/app.ts' },
          directory: '/tmp/test-project',
        });
        expect(result.continue).toBe(true);
        expect(result.message).toBeDefined();
        expect(result.message).toContain('DELEGATION REQUIRED');
        expect(result.message).toContain('src/app.ts');
        expect(result.message).toContain('Suggested agent:');
      });
    });

    describe('enforcement=strict', () => {
      it('write to source file blocks with continue=false, reason, and message', () => {
        setEnforcement('strict');
        const result = processOrchestratorPreTool({
          toolName: 'Write',
          toolInput: { filePath: 'src/app.ts' },
          directory: '/tmp/test-project',
        });
        expect(result.continue).toBe(false);
        expect(result.reason).toBe('DELEGATION_REQUIRED');
        expect(result.message).toBeDefined();
        expect(result.message).toContain('DELEGATION REQUIRED');
        expect(result.message).toContain('Suggested agent:');
      });
    });

    describe('allowed paths always continue', () => {
      const allowedPaths = [
        '.omc/plans/test.md',
        '.claude/settings.json',
        'docs/CLAUDE.md',
        'AGENTS.md',
      ];

      it.each(allowedPaths)(
        'allows %s regardless of enforcement level',
        (filePath) => {
          setEnforcement('strict');
          const result = processOrchestratorPreTool({
            toolName: 'Write',
            toolInput: { filePath },
            directory: '/tmp/test-project',
          });
          expect(result.continue).toBe(true);
          expect(result.reason).toBeUndefined();
        }
      );
    });

    describe('non-write tools always continue', () => {
      it.each(['Read', 'Bash', 'Glob', 'Grep', 'Task'])(
        '%s tool continues regardless of enforcement level',
        (toolName) => {
          setEnforcement('strict');
          const result = processOrchestratorPreTool({
            toolName,
            toolInput: { filePath: 'src/app.ts' },
            directory: '/tmp/test-project',
          });
          expect(result.continue).toBe(true);
          expect(result.message).toBeUndefined();
        }
      );
    });

    it('warning message includes agent suggestion text', () => {
      setEnforcement('warn');
      const result = processOrchestratorPreTool({
        toolName: 'Edit',
        toolInput: { filePath: 'src/component.tsx' },
        directory: '/tmp/test-project',
      });
      expect(result.message).toContain('Suggested agent: designer-low (simple) or designer (complex UI)');
    });

    it('handles filePath in different input keys', () => {
      setEnforcement('warn');

      // toolInput.path
      const result1 = processOrchestratorPreTool({
        toolName: 'Write',
        toolInput: { path: 'src/app.py' },
        directory: '/tmp/test-project',
      });
      expect(result1.message).toBeDefined();
      expect(result1.message).toContain('src/app.py');

      // toolInput.file
      const result2 = processOrchestratorPreTool({
        toolName: 'Write',
        toolInput: { file: 'src/app.go' },
        directory: '/tmp/test-project',
      });
      expect(result2.message).toBeDefined();
      expect(result2.message).toContain('src/app.go');
    });

    it('handles undefined toolInput gracefully', () => {
      setEnforcement('warn');
      const result = processOrchestratorPreTool({
        toolName: 'Write',
        toolInput: undefined,
        directory: '/tmp/test-project',
      });
      // No filePath extracted -> isAllowedPath(undefined) -> true -> continue
      expect(result.continue).toBe(true);
    });
  });

  // ─── 4. AuditEntry interface ───

  describe('AuditEntry interface', () => {
    it('accepts blocked decision', () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool: 'Write',
        filePath: 'src/app.ts',
        decision: 'blocked',
        reason: 'source_file',
        enforcementLevel: 'strict',
        sessionId: 'test-session',
      };
      expect(entry.decision).toBe('blocked');
      expect(entry.enforcementLevel).toBe('strict');
    });

    it('accepts warned decision', () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool: 'Edit',
        filePath: 'src/app.ts',
        decision: 'warned',
        reason: 'source_file',
        enforcementLevel: 'warn',
      };
      expect(entry.decision).toBe('warned');
      expect(entry.enforcementLevel).toBe('warn');
    });

    it('accepts allowed decision without enforcementLevel', () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool: 'Write',
        filePath: '.omc/plans/test.md',
        decision: 'allowed',
        reason: 'allowed_path',
      };
      expect(entry.decision).toBe('allowed');
      expect(entry.enforcementLevel).toBeUndefined();
    });

    it('enforcementLevel field is present in logged entries for warned/blocked', () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool: 'Write',
        filePath: 'src/app.ts',
        decision: 'blocked',
        reason: 'source_file',
        enforcementLevel: 'strict',
      };
      expect('enforcementLevel' in entry).toBe(true);
      expect(entry.enforcementLevel).toBeDefined();
    });
  });

  // ─── 5. processPreToolUse integration (bridge.ts) ───

  describe('processPreToolUse integration via processHook', () => {
    // We test the bridge by importing processHook
    // Need to dynamically import to get fresh mocks
    let processHook: typeof import('../hooks/bridge.js').processHook;

    beforeEach(async () => {
      // Mock additional bridge dependencies
      vi.mock('../hud/background-tasks.js', () => ({
        addBackgroundTask: vi.fn(),
        completeBackgroundTask: vi.fn(),
      }));
      vi.mock('../hooks/ralph/index.js', () => ({
        readRalphState: vi.fn(() => null),
        incrementRalphIteration: vi.fn(),
        clearRalphState: vi.fn(),
        createRalphLoopHook: vi.fn(() => ({ startLoop: vi.fn() })),
        readVerificationState: vi.fn(() => null),
        startVerification: vi.fn(),
        getArchitectVerificationPrompt: vi.fn(),
        clearVerificationState: vi.fn(),
      }));
      vi.mock('../hooks/keyword-detector/index.js', () => ({
        detectKeywordsWithType: vi.fn(() => []),
        removeCodeBlocks: vi.fn((t: string) => t),
      }));
      vi.mock('../hooks/todo-continuation/index.js', () => ({
        checkIncompleteTodos: vi.fn(async () => ({ count: 0 })),
      }));
      vi.mock('../hooks/persistent-mode/index.js', () => ({
        checkPersistentModes: vi.fn(async () => ({ shouldContinue: true })),
        createHookOutput: vi.fn(() => ({ continue: true })),
      }));
      vi.mock('../hooks/ultrawork/index.js', () => ({
        activateUltrawork: vi.fn(),
        readUltraworkState: vi.fn(() => null),
      }));
      vi.mock('../hooks/autopilot/index.js', () => ({
        readAutopilotState: vi.fn(() => null),
        isAutopilotActive: vi.fn(() => false),
        getPhasePrompt: vi.fn(),
        transitionPhase: vi.fn(),
        formatCompactSummary: vi.fn(),
      }));
      vi.mock('../installer/hooks.js', () => ({
        ULTRAWORK_MESSAGE: 'ultrawork',
        ULTRATHINK_MESSAGE: 'ultrathink',
        SEARCH_MESSAGE: 'search',
        ANALYZE_MESSAGE: 'analyze',
        TODO_CONTINUATION_PROMPT: 'continue',
        RALPH_MESSAGE: 'ralph',
      }));

      const bridge = await import('../hooks/bridge.js');
      processHook = bridge.processHook;
    });

    it('calls enforcement before HUD tracking', async () => {
      // With strict enforcement, a Write to source should be blocked
      // before any HUD tracking happens
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ delegationEnforcementLevel: 'strict' });
      });

      const result = await processHook('pre-tool-use', {
        toolName: 'Write',
        toolInput: { filePath: 'src/app.ts' },
        directory: '/tmp/test-project',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('DELEGATION_REQUIRED');
    });

    it('blocks propagated from enforcement', async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (/[\\/]\.omc[\\/]config\.json$/.test(s)) return true;
        return false;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ delegationEnforcementLevel: 'strict' });
      });

      const result = await processHook('pre-tool-use', {
        toolName: 'Edit',
        toolInput: { filePath: 'src/component.tsx' },
        directory: '/tmp/test-project',
      });

      expect(result.continue).toBe(false);
      expect(result.message).toContain('DELEGATION REQUIRED');
    });

    it('warnings propagated from enforcement', async () => {
      mockExistsSync.mockReturnValue(false); // default warn

      const result = await processHook('pre-tool-use', {
        toolName: 'Write',
        toolInput: { filePath: 'src/index.ts' },
        directory: '/tmp/test-project',
      });

      expect(result.continue).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message).toContain('DELEGATION REQUIRED');
    });

    it('Task tool tracking still works when enforcement passes', async () => {
      const { addBackgroundTask } = await import('../hud/background-tasks.js');
      const mockAddTask = vi.mocked(addBackgroundTask);

      mockExistsSync.mockReturnValue(false); // default warn, but Task is not a write tool

      const result = await processHook('pre-tool-use', {
        toolName: 'Task',
        toolInput: {
          description: 'Test task',
          prompt: 'do stuff',
          subagent_type: 'executor',
        },
        directory: '/tmp/test-project',
      });

      expect(result.continue).toBe(true);
      expect(mockAddTask).toHaveBeenCalledWith(
        expect.stringContaining('task-'),
        'Test task',
        'executor',
        '/tmp/test-project'
      );
    });
  });

  // ─── Helper function unit tests ───

  describe('isAllowedPath', () => {
    it('returns true for .omc/ paths', () => {
      expect(isAllowedPath('.omc/plans/test.md')).toBe(true);
    });

    it('returns true for .claude/ paths', () => {
      expect(isAllowedPath('.claude/settings.json')).toBe(true);
    });

    it('returns true for CLAUDE.md', () => {
      expect(isAllowedPath('CLAUDE.md')).toBe(true);
      expect(isAllowedPath('docs/CLAUDE.md')).toBe(true);
    });

    it('returns true for AGENTS.md', () => {
      expect(isAllowedPath('AGENTS.md')).toBe(true);
    });

    it('returns false for source files', () => {
      expect(isAllowedPath('src/app.ts')).toBe(false);
    });

    it('returns true for empty/falsy path', () => {
      expect(isAllowedPath('')).toBe(true);
    });
  });

  describe('isSourceFile', () => {
    it('returns true for source extensions', () => {
      expect(isSourceFile('app.ts')).toBe(true);
      expect(isSourceFile('app.py')).toBe(true);
      expect(isSourceFile('app.go')).toBe(true);
      expect(isSourceFile('app.rs')).toBe(true);
    });

    it('returns false for non-source extensions', () => {
      expect(isSourceFile('readme.txt')).toBe(false);
      expect(isSourceFile('data.yaml')).toBe(false);
    });

    it('returns false for empty path', () => {
      expect(isSourceFile('')).toBe(false);
    });
  });

  describe('isWriteEditTool', () => {
    it('returns true for write/edit tools', () => {
      expect(isWriteEditTool('Write')).toBe(true);
      expect(isWriteEditTool('Edit')).toBe(true);
      expect(isWriteEditTool('write')).toBe(true);
      expect(isWriteEditTool('edit')).toBe(true);
    });

    it('returns false for other tools', () => {
      expect(isWriteEditTool('Read')).toBe(false);
      expect(isWriteEditTool('Bash')).toBe(false);
      expect(isWriteEditTool('Task')).toBe(false);
    });
  });
});
