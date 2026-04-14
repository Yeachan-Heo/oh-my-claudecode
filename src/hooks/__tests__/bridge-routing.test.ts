/**
 * Bridge Routing Matrix Tests
 *
 * Tests that processHook routes each HookType correctly, handles
 * invalid/unknown types gracefully, validates input normalization,
 * and respects the OMC_SKIP_HOOKS env kill-switch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  processHook,
  resetSkipHooksCache,
  requiredKeysForHook,
  HookInput,
  HookType,
} from '../bridge.js';
import { flushPendingWrites } from '../subagent-tracker/index.js';

function writeCanonicalTeamState(tempDir: string, sessionId: string, teamName: string, phase: string): void {
  const canonicalTeamDir = join(tempDir, '.omc', 'state', 'team', teamName);
  mkdirSync(canonicalTeamDir, { recursive: true });
  writeFileSync(
    join(canonicalTeamDir, 'manifest.json'),
    JSON.stringify({
      name: teamName,
      task: `${teamName} task`,
      leader: {
        session_id: sessionId,
        worker_id: 'leader-fixed',
        role: 'leader',
      },
      created_at: new Date().toISOString(),
      leader_cwd: tempDir,
      team_state_root: join(tempDir, '.omc', 'state'),
    }, null, 2),
  );
  writeFileSync(
    join(canonicalTeamDir, 'phase-state.json'),
    JSON.stringify({
      current_phase: phase,
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
}

// ============================================================================
// Hook Routing Tests
// ============================================================================

describe('processHook - Routing Matrix', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    resetSkipHooksCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    resetSkipHooksCache();
  });

  // --------------------------------------------------------------------------
  // Route each HookType to a handler and confirm a valid HookOutput shape
  // --------------------------------------------------------------------------

  describe('HookType routing', () => {
    const baseInput: HookInput = {
      sessionId: 'test-session',
      prompt: 'test prompt',
      directory: '/tmp/test-routing',
    };

    const hookTypes: HookType[] = [
      'keyword-detector',
      'stop-continuation',
      'ralph',
      'persistent-mode',
      'session-start',
      'session-end',
      'pre-tool-use',
      'post-tool-use',
      'autopilot',
      'subagent-start',
      'subagent-stop',
      'pre-compact',
      'setup-init',
      'setup-maintenance',
      'permission-request',
    ];

    for (const hookType of hookTypes) {
      it(`should route "${hookType}" and return a valid HookOutput`, async () => {
        const result = await processHook(hookType, baseInput);

        // Every hook must return an object with a boolean "continue" field
        expect(result).toBeDefined();
        expect(typeof result.continue).toBe('boolean');

        // Optional fields, if present, must be the right type
        if (result.message !== undefined) {
          expect(typeof result.message).toBe('string');
        }
        if (result.reason !== undefined) {
          expect(typeof result.reason).toBe('string');
        }
      });
    }

    it('should handle keyword-detector with a keyword prompt', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'ultrawork this task',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result.continue).toBe(true);
      // Should detect the keyword and return a message
      expect(result.message).toBeDefined();
      expect(typeof result.message).toBe('string');
    });

    it('should route code review keyword to the review mode message', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'code review this change',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result.continue).toBe(true);
      expect(result.message).toContain('[CODE REVIEW MODE ACTIVATED]');
    });

    it('should route security review keyword to the security mode message', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'security review this change',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result.continue).toBe(true);
      expect(result.message).toContain('[SECURITY REVIEW MODE ACTIVATED]');
    });

    it('injects prompt prerequisite reminder and state for execution prompts with declared sections', async () => {
      const tempDir = process.cwd();
      try {
        const sessionId = 'keyword-prereq-session';

        const result = await processHook('keyword-detector', {
          sessionId,
          prompt: `ralph fix the parser

# MÉMOIRE
Use notepad_read and project_memory_read first.

# VERIFY-FIRST
Read src/hooks/bridge.ts before editing.`,
          directory: tempDir,
        });

        expect(result.continue).toBe(true);
        expect(result.message).toContain('[BLOCKING PREREQUISITE GATE]');
        expect(result.message).toContain('notepad_read');
        expect(result.message).toContain('src/hooks/bridge.ts');

        const prereqStatePath = join(process.cwd(), '.omc', 'state', 'sessions', sessionId, 'prompt-prerequisites-state.json');
        expect(existsSync(prereqStatePath)).toBe(true);

        const prereqState = JSON.parse(readFileSync(prereqStatePath, 'utf-8')) as {
          active?: boolean;
          required_tool_calls?: string[];
          required_file_paths?: string[];
        };
        expect(prereqState.active).toBe(true);
        expect(prereqState.required_tool_calls).toEqual(['notepad_read', 'project_memory_read']);
        expect(prereqState.required_file_paths).toEqual(['src/hooks/bridge.ts']);
      } finally {
        rmSync(join(process.cwd(), '.omc', 'state', 'sessions', 'keyword-prereq-session'), { recursive: true, force: true });
      }
    });

    it('should handle keyword-detector with no keyword prompt', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'just a regular message',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result.continue).toBe(true);
      // No keyword detected, so no message
      expect(result.message).toBeUndefined();
    });

    it('denies Edit until prompt prerequisites are completed, then unblocks after reads', async () => {
      const tempDir = process.cwd();
      try {
        const sessionId = 'prereq-pretool-session';

        await processHook('keyword-detector', {
          sessionId,
          prompt: `ultrawork fix it

# MÉMOIRE
Use notepad_read first.

# CONTEXT
Read src/hooks/bridge.ts first.`,
          directory: tempDir,
        });

        const denied = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Edit',
          toolInput: { file_path: 'src/hooks/bridge.ts' },
          directory: tempDir,
        });

        expect(denied.continue).toBe(true);
        expect((denied as unknown as Record<string, unknown>).hookSpecificOutput).toBeDefined();
        const denyHook = (denied as unknown as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
        expect(denyHook.permissionDecision).toBe('deny');
        expect(String(denyHook.permissionDecisionReason)).toContain('Blocking Edit');

        const readStep = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Read',
          toolInput: { file_path: 'src/hooks/bridge.ts' },
          directory: tempDir,
        });
        expect(readStep.continue).toBe(true);

        const toolStep = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'mcp__omx_notepad__notepad_read',
          toolInput: {},
          directory: tempDir,
        });
        expect(toolStep.continue).toBe(true);
        expect(String(toolStep.message ?? '')).toContain('PROMPT PREREQUISITES COMPLETE');

        const allowed = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Edit',
          toolInput: { file_path: 'src/hooks/bridge.ts' },
          directory: tempDir,
        });
        expect(allowed.continue).toBe(true);
        expect((allowed as unknown as Record<string, unknown>).hookSpecificOutput).toBeUndefined();
      } finally {
        rmSync(join(process.cwd(), '.omc', 'state', 'sessions', 'prereq-pretool-session'), { recursive: true, force: true });
      }
    });

    it('should handle pre-tool-use with Bash tool input', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
        directory: '/tmp/test-routing',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should handle post-tool-use with tool output', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
        toolOutput: 'hello',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
    });


    it('marks keyword-triggered ralph state as awaiting confirmation so stop enforcement stays inert', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-keyword-ralph-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'keyword-ralph-session';

        const keywordResult = await processHook('keyword-detector', {
          sessionId,
          prompt:
            'ralph fix the regression in src/hooks/bridge.ts after issue #1795 by tracing keyword-detector into persistent-mode, preserving session-scoped state behavior, verifying the confirmation gate, keeping linked ultrawork activation intact, adding a focused regression test for false-positive prose prompts, checking stop-hook enforcement only after real Skill invocation, and confirming the smallest safe fix without widening the mode activation surface or changing unrelated orchestration behavior in this worktree',
          directory: tempDir,
        });

        expect(keywordResult.continue).toBe(true);
        expect(keywordResult.message).toContain('[RALPH + ULTRAWORK MODE ACTIVATED]');

        const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        const ralphState = JSON.parse(readFileSync(join(sessionDir, 'ralph-state.json'), 'utf-8')) as {
          awaiting_confirmation?: boolean;
          awaiting_confirmation_set_at?: string;
          active?: boolean;
        };
        const ultraworkState = JSON.parse(readFileSync(join(sessionDir, 'ultrawork-state.json'), 'utf-8')) as {
          awaiting_confirmation?: boolean;
          awaiting_confirmation_set_at?: string;
          active?: boolean;
        };

        expect(ralphState.active).toBe(true);
        expect(ralphState.awaiting_confirmation).toBe(true);
        expect(typeof ralphState.awaiting_confirmation_set_at).toBe('string');
        expect(ultraworkState.active).toBe(true);
        expect(ultraworkState.awaiting_confirmation).toBe(true);
        expect(typeof ultraworkState.awaiting_confirmation_set_at).toBe('string');

        const stopResult = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(stopResult.continue).toBe(true);
        expect(stopResult.message).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('does not activate ultrawork state for explanatory reference follow-up prose', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-keyword-reference-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'keyword-reference-session';

        const keywordResult = await processHook('keyword-detector', {
          sessionId,
          prompt: 'OMC Ultrawork = "special ops". how much would it cost?',
          directory: tempDir,
        });

        expect(keywordResult.continue).toBe(true);
        expect(keywordResult.message).toBeUndefined();

        const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        expect(existsSync(join(sessionDir, 'ultrawork-state.json'))).toBe(false);

        const stopResult = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(stopResult.continue).toBe(true);
        expect(stopResult.message).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should activate ralph and linked ultrawork when Skill tool invokes ralph', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralph-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'test-session';
        const input: HookInput = {
          sessionId,
          toolName: 'Skill',
          toolInput: { skill: 'oh-my-claudecode:ralph' },
          directory: tempDir,
        };

        const result = await processHook('post-tool-use', input);
        expect(result.continue).toBe(true);

        const ralphPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
        const ultraworkPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');

        expect(existsSync(ralphPath)).toBe(true);
        expect(existsSync(ultraworkPath)).toBe(true);

        const ralphState = JSON.parse(readFileSync(ralphPath, 'utf-8')) as { active?: boolean; linked_ultrawork?: boolean };
        const ultraworkState = JSON.parse(readFileSync(ultraworkPath, 'utf-8')) as { active?: boolean; linked_to_ralph?: boolean };

        expect(ralphState.active).toBe(true);
        expect(ralphState.linked_ultrawork).toBe(true);
        expect(ultraworkState.active).toBe(true);
        expect(ultraworkState.linked_to_ralph).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('strips legacy --no-prd text but still starts Ralph in PRD mode from keyword routing', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-keyword-ralph-prd-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'keyword-ralph-prd-session';

        const result = await processHook('keyword-detector', {
          sessionId,
          prompt:
            'ralph --no-prd fix the startup gate in src/hooks/bridge.ts and src/hooks/ralph/loop.ts by removing legacy bypass handling, preserving critic flag support, keeping linked ultrawork activation intact, adding focused regression coverage for keyword and skill entrypoints, confirming the startup PRD scaffold is still created, and avoiding unrelated orchestration behavior changes anywhere else in this worktree',
          directory: tempDir,
        });

        expect(result.continue).toBe(true);

        const ralphPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
        const prdPath = join(tempDir, '.omc', 'prd.json');
        expect(existsSync(ralphPath)).toBe(true);
        expect(existsSync(prdPath)).toBe(true);

        const ralphState = JSON.parse(readFileSync(ralphPath, 'utf-8')) as { prompt?: string; prd_mode?: boolean };
        expect(ralphState.prompt).toBe(
          'ralph fix the startup gate in src/hooks/bridge.ts and src/hooks/ralph/loop.ts by removing legacy bypass handling, preserving critic flag support, keeping linked ultrawork activation intact, adding focused regression coverage for keyword and skill entrypoints, confirming the startup PRD scaffold is still created, and avoiding unrelated orchestration behavior changes anywhere else in this worktree',
        );
        expect(ralphState.prd_mode).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('clears awaiting confirmation when Skill tool actually invokes ralph', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-confirm-ralph-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'confirm-ralph-session';
        const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          join(sessionDir, 'ralph-state.json'),
          JSON.stringify({
            active: true,
            awaiting_confirmation: true,
            iteration: 1,
            max_iterations: 10,
            session_id: sessionId,
            started_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
            prompt: 'Test task',
          }, null, 2),
        );
        writeFileSync(
          join(sessionDir, 'ultrawork-state.json'),
          JSON.stringify({
            active: true,
            awaiting_confirmation: true,
            started_at: new Date().toISOString(),
            original_prompt: 'Test task',
            session_id: sessionId,
            reinforcement_count: 0,
            last_checked_at: new Date().toISOString(),
          }, null, 2),
        );

        const result = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Skill',
          toolInput: { skill: 'oh-my-claudecode:ralph' },
          directory: tempDir,
        });

        expect(result.continue).toBe(true);

        const ralphState = JSON.parse(readFileSync(join(sessionDir, 'ralph-state.json'), 'utf-8')) as {
          awaiting_confirmation?: boolean;
          awaiting_confirmation_set_at?: string;
        };
        const ultraworkState = JSON.parse(readFileSync(join(sessionDir, 'ultrawork-state.json'), 'utf-8')) as {
          awaiting_confirmation?: boolean;
          awaiting_confirmation_set_at?: string;
        };

        expect(ralphState.awaiting_confirmation).toBeUndefined();
        expect(ralphState.awaiting_confirmation_set_at).toBeUndefined();
        expect(ultraworkState.awaiting_confirmation).toBeUndefined();
        expect(ultraworkState.awaiting_confirmation_set_at).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('activates ralplan state when Skill tool invokes ralplan directly', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralplan-skill-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'ralplan-skill-session';

        const result = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Skill',
          toolInput: { skill: 'oh-my-claudecode:ralplan' },
          directory: tempDir,
        });

        expect(result.continue).toBe(true);

        const ralplanPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
        expect(existsSync(ralplanPath)).toBe(true);

        const ralplanState = JSON.parse(readFileSync(ralplanPath, 'utf-8')) as {
          active?: boolean;
          session_id?: string;
          current_phase?: string;
          awaiting_confirmation?: boolean;
        };

        expect(ralplanState.active).toBe(true);
        expect(ralplanState.session_id).toBe(sessionId);
        expect(ralplanState.current_phase).toBe('ralplan');
        expect(ralplanState.awaiting_confirmation).toBeUndefined();

        const stopResult = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(stopResult.continue).toBe(false);
        expect(stopResult.message).toContain('ralplan-continuation');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('arms ralplan startup state and init context for explicit /ralplan invoke in UserPromptSubmit', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralplan-slash-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'ralplan-slash-session';

        const result = await processHook('keyword-detector', {
          sessionId,
          prompt: '/oh-my-claudecode:ralplan issue #2622',
          directory: tempDir,
        });

        expect(result.continue).toBe(true);
        const hookSpecificOutput = (result as unknown as Record<string, unknown>)
          .hookSpecificOutput as Record<string, unknown>;
        expect(result.message).toBeUndefined();
        expect(hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
        expect(hookSpecificOutput.additionalContext).toContain('[RALPLAN INIT]');
        expect(hookSpecificOutput.additionalContext).toContain('/oh-my-claudecode:ralplan issue #2622');

        const ralplanPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
        expect(existsSync(ralplanPath)).toBe(true);

        const ralplanState = JSON.parse(readFileSync(ralplanPath, 'utf-8')) as {
          active?: boolean;
          session_id?: string;
          current_phase?: string;
          awaiting_confirmation?: boolean;
          awaiting_confirmation_set_at?: string;
        };

        expect(ralplanState.active).toBe(true);
        expect(ralplanState.session_id).toBe(sessionId);
        expect(ralplanState.current_phase).toBe('ralplan');
        expect(ralplanState.awaiting_confirmation).toBe(true);
        expect(typeof ralplanState.awaiting_confirmation_set_at).toBe('string');

        const stopResult = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(stopResult.continue).toBe(true);
        expect(stopResult.message).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('activates ralplan state when Skill tool invokes omc-plan in consensus mode', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-plan-consensus-skill-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'plan-consensus-skill-session';

        const result = await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Skill',
          toolInput: {
            skill: 'oh-my-claudecode:omc-plan',
            args: '--consensus issue #1926',
          },
          directory: tempDir,
        });

        expect(result.continue).toBe(true);

        const ralplanPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
        expect(existsSync(ralplanPath)).toBe(true);

        const ralplanState = JSON.parse(readFileSync(ralplanPath, 'utf-8')) as {
          active?: boolean;
          session_id?: string;
          current_phase?: string;
        };

        expect(ralplanState.active).toBe(true);
        expect(ralplanState.session_id).toBe(sessionId);
        expect(ralplanState.current_phase).toBe('ralplan');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('deactivates ralplan state when the consensus planning skill completes', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralplan-complete-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionId = 'ralplan-complete-session';

        await processHook('pre-tool-use', {
          sessionId,
          toolName: 'Skill',
          toolInput: { skill: 'oh-my-claudecode:ralplan' },
          directory: tempDir,
        });

        const postResult = await processHook('post-tool-use', {
          sessionId,
          toolName: 'Skill',
          toolInput: { skill: 'oh-my-claudecode:ralplan' },
          toolOutput: { ok: true },
          directory: tempDir,
        });

        expect(postResult.continue).toBe(true);

        const ralplanPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
        const ralplanState = JSON.parse(readFileSync(ralplanPath, 'utf-8')) as {
          active?: boolean;
          current_phase?: string;
          deactivated_reason?: string;
          completed_at?: string;
        };

        expect(ralplanState.active).toBe(false);
        expect(ralplanState.current_phase).toBe('complete');
        expect(ralplanState.deactivated_reason).toBe('skill_completed');
        expect(typeof ralplanState.completed_at).toBe('string');

        const stopResult = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(stopResult.continue).toBe(true);
        expect(stopResult.message).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should handle session-start and return continue:true', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('session-start', input);
      expect(result.continue).toBe(true);
    });

    it('should restore canonical team context when coarse team-state drifts away', async () => {
      const tempDir = process.cwd();
      const sessionId = 'canonical-team-session';
      const canonicalTeamDir = join(tempDir, '.omc', 'state', 'team', 'canonical-team');
      try {
        writeCanonicalTeamState(tempDir, sessionId, 'canonical-team', 'executing');

        const result = await processHook('session-start', {
          sessionId,
          directory: tempDir,
        } as HookInput);

        expect(result.continue).toBe(true);
        expect(result.message).toContain('[TEAM MODE RESTORED]');
        expect(result.message).toContain('canonical-team');
      } finally {
        rmSync(canonicalTeamDir, { recursive: true, force: true });
      }
    });

    it('should handle stop-continuation and always return continue:true', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('stop-continuation', input);
      expect(result.continue).toBe(true);
    });

    it('should enforce team continuation for active non-terminal team state', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-team-'));
      const sessionId = 'team-stage-enforced';
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const teamStateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(teamStateDir, { recursive: true });
        writeFileSync(
          join(teamStateDir, 'team-state.json'),
          JSON.stringify({ active: true, stage: 'team-exec', session_id: sessionId }, null, 2)
        );

        const result = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(result.continue).toBe(false);
        // checkTeamPipeline() in persistent-mode now handles team enforcement
        // instead of bridge.ts's own team enforcement
        expect(result.message).toContain('team-pipeline-continuation');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should bypass team continuation for auth error stop reasons', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-team-auth-'));
      const sessionId = 'team-stage-auth-bypass';
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const teamStateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(teamStateDir, { recursive: true });
        writeFileSync(
          join(teamStateDir, 'team-state.json'),
          JSON.stringify({ active: true, stage: 'team-exec', session_id: sessionId }, null, 2)
        );

        const result = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'oauth_expired',
        } as HookInput);

        expect(result.continue).toBe(true);
        expect(result.message).toMatch(/authentication/i);
        expect(result.message).not.toContain('[TEAM MODE CONTINUATION]');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });


    it('should not append legacy team continuation when ralplan already blocks stop', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralplan-team-'));
      const sessionId = 'ralplan-team-double-block';
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const sessionStateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(sessionStateDir, { recursive: true });
        writeFileSync(
          join(sessionStateDir, 'ralplan-state.json'),
          JSON.stringify({ active: true, session_id: sessionId, current_phase: 'ralplan' }, null, 2)
        );

        const globalStateDir = join(tempDir, '.omc', 'state');
        mkdirSync(globalStateDir, { recursive: true });
        writeFileSync(
          join(globalStateDir, 'team-state.json'),
          JSON.stringify({ active: true, stage: 'team-exec' }, null, 2)
        );

        const result = await processHook('persistent-mode', {
          sessionId,
          directory: tempDir,
          stop_reason: 'end_turn',
        } as HookInput);

        expect(result.continue).toBe(false);
        expect(result.message).toContain('ralplan-continuation');
        expect(result.message).not.toContain('team-stage-continuation');
        expect(result.message).not.toContain('team-pipeline-continuation');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Invalid / unknown hook types
  // --------------------------------------------------------------------------

  describe('invalid hook types', () => {
    it('should return continue:true for unknown hook type', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test-routing',
      };

      // Cast to HookType to simulate an unknown type
      const result = await processHook('nonexistent-hook' as HookType, input);
      expect(result).toEqual({ continue: true });
    });

    it('should return continue:true for empty string hook type', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('' as HookType, input);
      expect(result).toEqual({ continue: true });
    });
  });

  // --------------------------------------------------------------------------
  // Input normalization (snake_case -> camelCase)
  // --------------------------------------------------------------------------

  describe('input normalization', () => {
    it('should normalize snake_case tool_name to camelCase toolName', async () => {
      // Send snake_case input (as Claude Code would)
      const rawInput = {
        session_id: 'test-session',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        cwd: '/tmp/test-routing',
      } as unknown as HookInput;

      const result = await processHook('pre-tool-use', rawInput);
      // Should not crash - normalization handled the field mapping
      expect(result).toBeDefined();
      expect(typeof result.continue).toBe('boolean');
    });

    it('should normalize cwd to directory', async () => {
      const rawInput = {
        session_id: 'test-session',
        cwd: '/tmp/test-routing',
        prompt: 'hello',
      } as unknown as HookInput;

      const result = await processHook('keyword-detector', rawInput);
      expect(result).toBeDefined();
      expect(result.continue).toBe(true);
    });

    it('should normalize tool_response to toolOutput', async () => {
      const rawInput = {
        session_id: 'test-session',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.ts' },
        tool_response: 'file contents here',
        cwd: '/tmp/test-routing',
      } as unknown as HookInput;

      const result = await processHook('post-tool-use', rawInput);
      expect(result).toBeDefined();
      expect(typeof result.continue).toBe('boolean');
    });

    it('should handle already-camelCase input without breaking', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        directory: '/tmp/test-routing',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result).toBeDefined();
      expect(typeof result.continue).toBe('boolean');
    });

    it('should handle empty/null input gracefully', async () => {
      const result = await processHook('keyword-detector', {} as HookInput);
      expect(result).toBeDefined();
      expect(result.continue).toBe(true);
    });

    it('should handle null input without crashing', async () => {
      const result = await processHook('keyword-detector', null as unknown as HookInput);
      expect(result).toBeDefined();
      expect(result.continue).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // OMC_SKIP_HOOKS environment variable
  // --------------------------------------------------------------------------

  describe('OMC_SKIP_HOOKS kill-switch', () => {
    it('should skip a specific hook type when listed', async () => {
      process.env.OMC_SKIP_HOOKS = 'keyword-detector';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'ultrawork this',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      // Should be skipped - no message, just continue
      expect(result).toEqual({ continue: true });
    });

    it('should not skip hooks not in the list', async () => {
      process.env.OMC_SKIP_HOOKS = 'keyword-detector';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('stop-continuation', input);
      expect(result.continue).toBe(true);
    });

    it('should skip multiple comma-separated hooks', async () => {
      process.env.OMC_SKIP_HOOKS = 'keyword-detector,pre-tool-use,post-tool-use';

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        directory: '/tmp/test-routing',
      };

      const keywordResult = await processHook('keyword-detector', input);
      const preToolResult = await processHook('pre-tool-use', input);
      const postToolResult = await processHook('post-tool-use', input);

      expect(keywordResult).toEqual({ continue: true });
      expect(preToolResult).toEqual({ continue: true });
      expect(postToolResult).toEqual({ continue: true });
    });

    it('should handle whitespace around hook names', async () => {
      process.env.OMC_SKIP_HOOKS = ' keyword-detector , pre-tool-use ';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'ultrawork',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result).toEqual({ continue: true });
    });

    it('should process normally with empty OMC_SKIP_HOOKS', async () => {
      process.env.OMC_SKIP_HOOKS = '';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result.continue).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // DISABLE_OMC env kill-switch
  // --------------------------------------------------------------------------

  describe('DISABLE_OMC kill-switch', () => {
    it('should return continue:true for all hooks when DISABLE_OMC=1', async () => {
      process.env.DISABLE_OMC = '1';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'ultrawork this',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result).toEqual({ continue: true });
    });

    it('should return continue:true when DISABLE_OMC=true', async () => {
      process.env.DISABLE_OMC = 'true';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result).toEqual({ continue: true });
    });

    it('should process normally when DISABLE_OMC=false', async () => {
      process.env.DISABLE_OMC = 'false';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      // Should process normally (not disabled)
      expect(result.continue).toBe(true);
    });

    it('DISABLE_OMC takes precedence over OMC_SKIP_HOOKS', async () => {
      process.env.DISABLE_OMC = '1';
      process.env.OMC_SKIP_HOOKS = 'keyword-detector';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'ultrawork',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('keyword-detector', input);
      expect(result).toEqual({ continue: true });
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error resilience', () => {
    it('should catch errors and return continue:true', async () => {
      // Suppress console.error for this test
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // subagent-start requires specific fields - sending bad input may trigger error path
      const input: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/nonexistent-test-dir-12345',
      };

      const result = await processHook('autopilot', input);
      // Should not crash, should return continue:true
      expect(result.continue).toBe(true);

      spy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // Regression: camelCase validation after normalization (PR #512 fix)
  // --------------------------------------------------------------------------

  describe('camelCase validation after normalization', () => {
    const affectedHooks: HookType[] = [
      'session-end',
      'subagent-start',
      'subagent-stop',
      'pre-compact',
      'setup-init',
      'setup-maintenance',
    ];

    for (const hookType of affectedHooks) {
      it(`"${hookType}" should pass validation with camelCase input (post-normalization)`, async () => {
        // Suppress console.error from lazy-load failures in non-existent dirs
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // camelCase input (as produced by normalizeHookInput)
        const input: HookInput = {
          sessionId: 'test-session-abc',
          directory: '/tmp/test-routing',
          toolName: 'Bash',
        };

        const result = await processHook(hookType, input);
        // Should NOT silently fail validation — it should reach the handler
        // (handler may still return continue:true due to missing state files, which is fine)
        expect(result).toBeDefined();
        expect(typeof result.continue).toBe('boolean');

        // The key assertion: validation should NOT log a "missing keys" error
        // for sessionId/directory since they are present in camelCase
        const missingKeysLogs = spy.mock.calls.filter(
          (args) => typeof args[0] === 'string' && args[0].includes('missing keys'),
        );
        expect(missingKeysLogs).toHaveLength(0);

        spy.mockRestore();
      });
    }

    it('"permission-request" should pass validation with camelCase input including toolName', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const input: HookInput = {
        sessionId: 'test-session-abc',
        directory: '/tmp/test-routing',
        toolName: 'Bash',
      };

      const result = await processHook('permission-request', input);
      expect(result).toBeDefined();
      expect(typeof result.continue).toBe('boolean');

      const missingKeysLogs = spy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('missing keys'),
      );
      expect(missingKeysLogs).toHaveLength(0);

      spy.mockRestore();
    });

    it('should fail validation when required camelCase keys are missing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Missing sessionId and directory
      const input = { prompt: 'hello' } as unknown as HookInput;

      const result = await processHook('session-end', input);
      expect(result).toEqual({ continue: true });

      // Should have logged the missing keys
      const missingKeysLogs = spy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('missing keys'),
      );
      expect(missingKeysLogs.length).toBeGreaterThan(0);

      spy.mockRestore();
    });

    it('snake_case input should be normalized and pass validation', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Raw snake_case input as Claude Code would send
      const rawInput = {
        session_id: 'test-session-xyz',
        cwd: '/tmp/test-routing',
        tool_name: 'Read',
      } as unknown as HookInput;

      const result = await processHook('session-end', rawInput);
      expect(result).toBeDefined();
      expect(typeof result.continue).toBe('boolean');

      // normalizeHookInput converts session_id→sessionId, cwd→directory
      // so validation against camelCase keys should succeed
      const missingKeysLogs = spy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('missing keys'),
      );
      expect(missingKeysLogs).toHaveLength(0);

      spy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // Regression: requiredKeysForHook helper
  // --------------------------------------------------------------------------

  describe('requiredKeysForHook', () => {
    it('should return camelCase keys for session-end', () => {
      expect(requiredKeysForHook('session-end')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys for subagent-start', () => {
      expect(requiredKeysForHook('subagent-start')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys for subagent-stop', () => {
      expect(requiredKeysForHook('subagent-stop')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys for pre-compact', () => {
      expect(requiredKeysForHook('pre-compact')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys for setup-init', () => {
      expect(requiredKeysForHook('setup-init')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys for setup-maintenance', () => {
      expect(requiredKeysForHook('setup-maintenance')).toEqual(['sessionId', 'directory']);
    });

    it('should return camelCase keys with toolName for permission-request', () => {
      expect(requiredKeysForHook('permission-request')).toEqual(['sessionId', 'directory', 'toolName']);
    });

    it('should return empty array for unknown hook type', () => {
      expect(requiredKeysForHook('unknown-hook')).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Regression: autopilot session isolation (sessionId threading)
  // --------------------------------------------------------------------------

  describe('autopilot session threading', () => {
    it('should pass sessionId to readAutopilotState for session isolation', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // With a sessionId, the autopilot handler should thread it to readAutopilotState
      // Since no state file exists, it returns continue:true — but it should not crash
      const input: HookInput = {
        sessionId: 'isolated-session-123',
        directory: '/tmp/test-routing-autopilot',
      };

      const result = await processHook('autopilot', input);
      expect(result.continue).toBe(true);

      spy.mockRestore();
    });

    it('should handle autopilot without sessionId gracefully', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const input: HookInput = {
        directory: '/tmp/test-routing-autopilot',
      };

      const result = await processHook('autopilot', input);
      expect(result.continue).toBe(true);

      spy.mockRestore();
    });

    it('surfaces blocker details in autopilot hook output', async () => {
      const testDir = process.cwd();
      try {
        const sessionId = 'autopilot-blockers-session';
        const sessionDir = join(testDir, '.omc', 'state', 'sessions', sessionId);
        const teamRoot = join(testDir, '.omc', 'state', 'team', 'bridge-autopilot-demo-team');
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
        writeFileSync(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          phase: 'planning',
          session_id: sessionId,
          originalIdea: 'demo task',
          expansion: { spec_path: null },
          planning: { plan_path: null },
        }, null, 2));
        writeFileSync(join(sessionDir, 'team-state.json'), JSON.stringify({
          active: true,
          session_id: sessionId,
          team_name: 'bridge-autopilot-demo-team',
          current_phase: 'team-exec',
        }, null, 2));
        writeCanonicalTeamState(testDir, sessionId, 'bridge-autopilot-demo-team', 'executing');
        writeFileSync(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
          id: '1',
          subject: 'Blocked task',
          description: 'Depends on missing task 13',
          status: 'pending',
          owner: 'worker-1',
          blocked_by: ['13'],
          depends_on: ['13'],
          created_at: new Date().toISOString(),
        }, null, 2));

        const result = await processHook('autopilot', {
          sessionId,
          directory: testDir,
        });

        expect(result.continue).toBe(true);
        expect(result.message).toContain('[AUTOPILOT - Phase: PLANNING]');
        expect(result.message).toContain('[bridge-autopilot-demo-team] task-1 depends on missing task ids [13]');
      } finally {
        rmSync(join(testDir, '.omc', 'state', 'sessions', 'autopilot-blockers-session'), { recursive: true, force: true });
        rmSync(join(testDir, '.omc', 'state', 'team', 'bridge-autopilot-demo-team'), { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Unknown hook types still return continue:true
  // --------------------------------------------------------------------------

  describe('unknown hook types (regression)', () => {
    it('should return continue:true for completely unknown hook type', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/test-routing',
      };

      const result = await processHook('totally-unknown-hook-xyz' as HookType, input);
      expect(result).toEqual({ continue: true });
    });
  });

  // --------------------------------------------------------------------------
  // Regression #858 — snake_case fields must reach handlers after normalization
  //
  // processHook() normalizes Claude Code's snake_case payload (session_id,
  // cwd, tool_name, tool_input) to camelCase before routing.  The handlers
  // for session-end, pre-compact, setup-init, setup-maintenance, and
  // permission-request all expect the original snake_case field names, so
  // processHook must de-normalize before calling them.
  // --------------------------------------------------------------------------

  describe('Regression #858 — snake_case fields reach handlers after normalization', () => {
    it('permission-request: snake_case input auto-allows safe command (tool_name/tool_input reached handler)', async () => {
      // "git status" is in SAFE_PATTERNS. If tool_name and tool_input are
      // de-normalized correctly, the handler returns hookSpecificOutput with
      // behavior:'allow'. Before the fix, tool_name was undefined so the
      // handler returned { continue: true } with no hookSpecificOutput.
      const rawInput = {
        session_id: 'test-session-858',
        cwd: '/tmp/test-routing',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_use_id: 'tool-use-123',
        transcript_path: '/tmp/transcript.jsonl',
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
      } as unknown as HookInput;

      const result = await processHook('permission-request', rawInput);
      expect(result.continue).toBe(true);
      const out = result as unknown as Record<string, unknown>;
      expect(out.hookSpecificOutput).toBeDefined();
      const specific = out.hookSpecificOutput as Record<string, unknown>;
      expect(specific.hookEventName).toBe('PermissionRequest');
      const decision = specific.decision as Record<string, unknown>;
      expect(decision.behavior).toBe('allow');
    });

    it('permission-request: camelCase input auto-allows explicitly targeted single-test commands', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-permission-camel-'));
      try {
        mkdirSync(join(tempDir, 'src', '__tests__'), { recursive: true });
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        writeFileSync(join(tempDir, 'src', '__tests__', 'safe.test.ts'), 'test("x", () => {});\n');

        const input: HookInput = {
          sessionId: 'test-session-858',
          directory: tempDir,
          toolName: 'Bash',
          toolInput: { command: 'vitest run src/__tests__/safe.test.ts' },
        };

        const result = await processHook('permission-request', input);
        expect(result.continue).toBe(true);
        const out = result as unknown as Record<string, unknown>;
        expect(out.hookSpecificOutput).toBeDefined();
        const specific = out.hookSpecificOutput as Record<string, unknown>;
        const decision = specific.decision as Record<string, unknown>;
        expect(decision.behavior).toBe('allow');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('setup-init: snake_case input reaches handler and returns additionalContext', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-setup-'));
      try {
        const rawInput = {
          session_id: 'test-session-858',
          cwd: tempDir,
          transcript_path: join(tempDir, 'transcript.jsonl'),
          permission_mode: 'default',
          hook_event_name: 'Setup',
        } as unknown as HookInput;

        const result = await processHook('setup-init', rawInput);
        expect(result.continue).toBe(true);
        const out = result as unknown as Record<string, unknown>;
        expect(out.hookSpecificOutput).toBeDefined();
        const specific = out.hookSpecificOutput as Record<string, unknown>;
        expect(specific.hookEventName).toBe('Setup');
        expect(typeof specific.additionalContext).toBe('string');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('session-end: snake_case input reaches handler without crashing', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-session-end-'));
      try {
        const rawInput = {
          session_id: 'test-session-858',
          cwd: tempDir,
          transcript_path: join(tempDir, 'transcript.jsonl'),
          permission_mode: 'default',
          hook_event_name: 'SessionEnd',
          reason: 'other',
        } as unknown as HookInput;

        const result = await processHook('session-end', rawInput);
        expect(result.continue).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('pre-compact: snake_case input reaches handler and creates checkpoint directory', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-pre-compact-'));
      try {
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const rawInput = {
          session_id: 'test-session-858',
          cwd: tempDir,
          transcript_path: join(tempDir, 'transcript.jsonl'),
          permission_mode: 'default',
          hook_event_name: 'PreCompact',
          trigger: 'manual',
        } as unknown as HookInput;

        const result = await processHook('pre-compact', rawInput);
        expect(result.continue).toBe(true);
        // If cwd reached the handler, it will have created the checkpoint dir
        const checkpointDir = join(tempDir, '.omc', 'state', 'checkpoints');
        expect(existsSync(checkpointDir)).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('setup-maintenance: hook type routing overrides conflicting trigger input', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-setup-maint-'));
      try {
        const rawInput = {
          session_id: 'test-session-858',
          cwd: tempDir,
          transcript_path: join(tempDir, 'transcript.jsonl'),
          permission_mode: 'default',
          hook_event_name: 'Setup',
          trigger: 'init',
        } as unknown as HookInput;

        const result = await processHook('setup-maintenance', rawInput);
        expect(result.continue).toBe(true);
        const out = result as unknown as Record<string, unknown>;
        const specific = out.hookSpecificOutput as Record<string, unknown>;
        expect(specific.hookEventName).toBe('Setup');
        const context = String(specific.additionalContext ?? '');
        expect(context).toContain('OMC maintenance completed:');
        expect(context).not.toContain('OMC initialized:');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('subagent start/stop: normalized optional fields survive routing lifecycle', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bridge-858-subagent-'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const startInput = {
          session_id: 'test-session-858-subagent',
          cwd: tempDir,
          agent_id: 'agent-858',
          agent_type: 'executor',
          prompt: 'Investigate normalization edge regression in bridge routing',
          model: 'gpt-5.3-codex-spark',
        } as unknown as HookInput;

        const start = await processHook('subagent-start', startInput);
        expect(start.continue).toBe(true);

        const stopInput = {
          sessionId: 'test-session-858-subagent',
          directory: tempDir,
          agent_id: 'agent-858',
          agent_type: 'executor',
          output: 'routing complete with normalized fields',
          success: false,
        } as unknown as HookInput;

        const stop = await processHook('subagent-stop', stopInput);
        expect(stop.continue).toBe(true);

        flushPendingWrites();

        const trackingPath = join(tempDir, '.omc', 'state', 'subagent-tracking.json');
        expect(existsSync(trackingPath)).toBe(true);

        const tracking = JSON.parse(readFileSync(trackingPath, 'utf-8')) as {
          agents: Array<Record<string, unknown>>;
          total_failed: number;
          total_completed: number;
        };

        const agent = tracking.agents.find((a) => a.agent_id === 'agent-858');
        expect(agent).toBeDefined();
        expect(agent?.task_description).toBe('Investigate normalization edge regression in bridge routing');
        expect(agent?.model).toBe('gpt-5.3-codex-spark');
        expect(agent?.status).toBe('failed');
        expect(String(agent?.output_summary ?? '')).toContain('routing complete with normalized fields');
        expect(tracking.total_failed).toBeGreaterThanOrEqual(1);
        expect(tracking.total_completed).toBe(0);
      } finally {
        flushPendingWrites();
        errorSpy.mockRestore();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('permission-request: canonical hookEventName wins over conflicting raw hook_event_name', async () => {
      const rawInput = {
        session_id: 'test-session-858',
        cwd: '/tmp/test-routing',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        hook_event_name: 'NotPermissionRequest',
      } as unknown as HookInput;

      const result = await processHook('permission-request', rawInput);
      expect(result.continue).toBe(true);
      const out = result as unknown as Record<string, unknown>;
      const specific = out.hookSpecificOutput as Record<string, unknown>;
      expect(specific.hookEventName).toBe('PermissionRequest');
    });
  });
});
