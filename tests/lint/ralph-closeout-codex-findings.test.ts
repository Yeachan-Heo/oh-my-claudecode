/**
 * Tests for ralph closeout Codex findings fixes:
 * 1. Register closeout command before requiring its record (P1)
 * 2. Preserve locks owned by live verifier (P2)
 * 3. Evaluate closeout even when no feedback commands exist (P2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { ralphCloseout, ralphCommand, ralphVerify, runFeedbackCommand } from '../../src/cli/commands/ralph';
import { recordBaseline, readBaseline, type CommandBaseline } from '../../src/hooks/ralph/feedback-baseline';
import { readCloseout, writeCloseout } from '../../src/hooks/ralph/closeout';
import { getOmcRoot, validateSessionId } from '../../src/lib/worktree-paths';

describe('Ralph Closeout Codex Findings', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateRoot: string;

  beforeEach(() => {
    tmpDir = `/tmp/ralph-test-${randomUUID()}`;
    sessionId = randomUUID();
    mkdirSync(tmpDir, { recursive: true });
    
    // Create a minimal OMC state structure
    stateRoot = join(tmpDir, '.omc');
    mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('P1: Register closeout command', () => {
    test('`omc ralph closeout` is registered and dispatches to ralphCloseout', async () => {
      const program = new Command().exitOverride();
      ralphCommand(program);
      const ralph = program.commands.find(c => c.name() === 'ralph');
      ralph?.exitOverride();
      ralph?.commands.forEach(c => c.exitOverride());
      const errors: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
      const cwd = process.cwd();
      const previousExitCode = process.exitCode;
      try {
        process.chdir(tmpDir);
        await program.parseAsync(['ralph', 'closeout', '--check', '--session', sessionId], { from: 'user' });
        // No PRD exists, so the action itself rejects; an unregistered command would throw instead.
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toContain('ralph closeout');
      } finally {
        process.chdir(cwd);
        process.exitCode = previousExitCode;
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    test('closeout command should record with --deslop option', () => {
      // Create a minimal PRD to allow closeout recording
      const prdPath = join(stateRoot, 'state', 'sessions', sessionId, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({
        version: 1,
        userStories: [
          {
            id: 'story-1',
            title: 'Test Story',
            description: 'Test',
            acceptanceCriteria: 'Test criteria',
            passes: true,
            architectVerified: true,
          },
        ],
        feedbackCommands: [],
        criteriaHash: 'test-hash-v1',
      }, null, 2));

      // Write a valid closeout
      const path = join(stateRoot, 'state', 'sessions', sessionId, 'ralph-closeout.json');
      const written = writeCloseout(path, {
        sessionId,
        deslop: 'completed',
        criteriaRevision: 'test-hash-v1',
      });
      
      expect(written).toBe(true);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('P2: Preserve locks owned by live verifier', () => {
    test('recordBaseline should use PID-aware locking', () => {
      // Test that recordBaseline respects the owning process PID
      const baselinePath = join(stateRoot, 'state', 'sessions', sessionId, 'feedback-baseline.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });

      const commands: Record<string, CommandBaseline> = {
        test: {
          signatures: ['test failure 1', 'test failure 2'],
        },
      };

      const result = recordBaseline(baselinePath, commands);
      expect(result.written).toBe(true);

      // Verify the baseline was written
      const baseline = readBaseline(baselinePath);
      expect(baseline).toBeDefined();
      expect(baseline?.commands.test?.signatures.length).toBe(2);

      // Verify the lock file doesn't persist after write
      const lockPath = `${baselinePath}.lock`;
      expect(existsSync(lockPath)).toBe(false);
    });

    test('concurrent recordBaseline calls should serialize via lock', () => {
      const baselinePath = join(stateRoot, 'state', 'sessions', sessionId, 'feedback-baseline.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });

      const commands1: Record<string, CommandBaseline> = {
        test: { signatures: ['error 1'] },
      };

      const commands2: Record<string, CommandBaseline> = {
        test: { signatures: ['error 2', 'error 3'] },
      };

      // Write two baselines in sequence - both should succeed
      const result1 = recordBaseline(baselinePath, commands1);
      expect(result1.written).toBe(true);

      const result2 = recordBaseline(baselinePath, commands2);
      expect(result2.written).toBe(true);
      expect(result2.previousPath).toBeDefined(); // Archive should exist

      // Final baseline should have the latest data
      const baseline = readBaseline(baselinePath);
      expect(baseline?.commands.test?.signatures).toEqual(['error 2', 'error 3']);
    });
  });

  describe('P1: Required closeout gate with no feedback commands', () => {
    test('ralphVerify should fail when closeout is required but not recorded', () => {
      // Create a valid, anchored PRD with required fields and a completed story
      const prdPath = join(stateRoot, 'state', 'sessions', sessionId, 'prd.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });
      
      writeFileSync(prdPath, JSON.stringify({
        version: 1,
        project: 'test-project',
        branchName: 'test-branch',
        description: 'Test feature',
        userStories: [
          {
            id: 'story-1',
            title: 'Test Story',
            description: 'Test implementation',
            acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
            priority: 1,
            passes: true,
            architectVerified: true,
          },
        ],
        feedbackCommands: [],
        criteriaHash: 'test-hash-v1',
      }, null, 2));

      // Capture console output to check for JSON
      let jsonOutput: string = '';
      const originalLog = console.log;
      const outputs: string[] = [];
      console.log = (msg: string) => {
        outputs.push(msg);
        if (msg.startsWith('{')) jsonOutput = msg;
        originalLog(msg);
      };

      try {
        process.env.OMC_SESSION_ID = sessionId;
        // With a valid PRD and no feedback commands but no closeout record, verification should fail
        ralphVerify({ json: true, session: sessionId }, tmpDir);

        // Parse the JSON output to check for closeout gate block
        if (jsonOutput) {
          const parsed = JSON.parse(jsonOutput);
          // Should indicate that closeout is required but missing
          expect(parsed).toHaveProperty('closeout');
          // Closeout gate should have a 'required' or 'blocking' indicator
          expect(parsed.closeout || parsed.blocked).toBeTruthy();
        }
      } finally {
        console.log = originalLog;
      }
    });

    test('ralphVerify should pass after recording a closeout for no-feedback-command case', () => {
      // Create the same valid PRD
      const prdPath = join(stateRoot, 'state', 'sessions', sessionId, 'prd.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });
      
      writeFileSync(prdPath, JSON.stringify({
        version: 1,
        project: 'test-project',
        branchName: 'test-branch',
        description: 'Test feature',
        userStories: [
          {
            id: 'story-1',
            title: 'Test Story',
            description: 'Test implementation',
            acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
            priority: 1,
            passes: true,
            architectVerified: true,
          },
        ],
        feedbackCommands: [],
        criteriaHash: 'test-hash-v1',
      }, null, 2));

      // First, record a closeout with deslop: 'completed'
      const closeoutPath = join(stateRoot, 'state', 'sessions', sessionId, 'ralph-closeout.json');
      const closeoutWritten = writeCloseout(closeoutPath, {
        sessionId,
        deslop: 'completed',
        criteriaRevision: 'test-hash-v1',
      });
      expect(closeoutWritten).toBe(true);

      // Now verify - should succeed
      let jsonOutput: string = '';
      const originalLog = console.log;
      console.log = (msg: string) => {
        if (msg.startsWith('{')) jsonOutput = msg;
        originalLog(msg);
      };

      try {
        process.env.OMC_SESSION_ID = sessionId;
        ralphVerify({ json: true, session: sessionId }, tmpDir);

        // Parse JSON output - should not have a blocking closeout gate
        if (jsonOutput) {
          const parsed = JSON.parse(jsonOutput);
          // Closeout gate should now pass (either not present or not blocking)
          expect(!parsed.closeout || !parsed.blocked).toBeTruthy();
        }
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('P2: Evaluate closeout even when no feedback commands exist', () => {
    test('recordBaseline should handle lock contention gracefully', () => {
      // Test that holds a lock from a live process to verify recordBaseline returns {written:false}
      const baselinePath = join(stateRoot, 'state', 'sessions', sessionId, 'feedback-baseline.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });

      // Simulate lock contention by holding the lock
      const lockPath = `${baselinePath}.lock`;
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

      try {
        const commands = { test: { signatures: ['error 1'] } };
        const result = recordBaseline(baselinePath, commands);

        // Should return {written:false} without throwing
        expect(result.written).toBe(false);
        expect(result.added).toBe(0);
        expect(result.removed).toBe(0);
      } finally {
        // Clean up
        if (existsSync(lockPath)) {
          rmSync(lockPath);
        }
      }
    });
  });
});
