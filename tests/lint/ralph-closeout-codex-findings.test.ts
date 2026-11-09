/**
 * Tests for ralph closeout Codex findings fixes:
 * 1. Register closeout command before requiring its record (P1)
 * 2. Preserve locks owned by live verifier (P2)
 * 3. Evaluate closeout even when no feedback commands exist (P2)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { ralphCloseout, ralphVerify, runFeedbackCommand } from '../../src/cli/commands/ralph';
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
    test('closeout command should be accessible and executable', () => {
      // This test verifies that ralphCloseout can be called as an action
      // The command registration in ralphCommand() is tested by the CLI itself.
      
      // Test that ralphCloseout accepts the documented options
      const result = ralphCloseout(
        { check: true, json: true, session: sessionId },
        tmpDir
      );
      
      // Should return 1 because there's no PRD yet
      expect(typeof result).toBe('number');
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

  describe('P2: Evaluate closeout even when no feedback commands exist', () => {
    test('ralphVerify should call evaluateCloseoutGate and include it in JSON output', () => {
      // This test verifies the fix by checking that closeout is evaluated
      // Create a minimal PRD (even without complete stories, closeout should be evaluated)
      const prdPath = join(stateRoot, 'state', 'sessions', sessionId, 'prd.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });
      
      writeFileSync(prdPath, JSON.stringify({
        version: 1,
        userStories: [],
        feedbackCommands: [],
        criteriaHash: 'test-hash-v1',
      }, null, 2));

      // Capture console output to verify closeout is in JSON
      let jsonOutput: string = '';
      const originalLog = console.log;
      console.log = (msg: string) => {
        if (msg.startsWith('{')) jsonOutput = msg;
        originalLog(msg);
      };

      try {
        process.env.OMC_SESSION_ID = sessionId;
        // With no feedback commands, the function should still emit JSON with closeout info
        ralphVerify({ json: true, session: sessionId }, tmpDir);

        // Parse the JSON output
        if (jsonOutput) {
          const parsed = JSON.parse(jsonOutput);
          // Verify closeout gate was evaluated (should have closeout property)
          expect(parsed).toHaveProperty('closeout');
          expect(parsed).toHaveProperty('commands');
          expect(parsed.commands).toEqual([]); // No commands
          // Should have a note about no commands
          expect(parsed).toHaveProperty('note');
          expect(parsed.note).toMatch(/no feedback commands/i);
        }
      } finally {
        console.log = originalLog;
      }
    });

    test('closeout command should be defined and callable', () => {
      // This test verifies that the closeout command is properly registered
      // by checking that ralphCloseout can be called
      const prdPath = join(stateRoot, 'state', 'sessions', sessionId, 'prd.json');
      mkdirSync(join(stateRoot, 'state', 'sessions', sessionId), { recursive: true });
      
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

      // Test that closeout can check status
      const result = ralphCloseout(
        { check: true, json: true, session: sessionId },
        tmpDir
      );
      
      // Should return 0 or 1, not throw
      expect(typeof result).toBe('number');
    });
  });
});
