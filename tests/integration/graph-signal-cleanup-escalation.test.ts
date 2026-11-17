/**
 * Regression test for graph signal cleanup escalation timeout.
 * Verifies that SIGKILL escalation fires even if child process closes
 * before escalation timeout (e.g., when child spawns SIGTERM-ignoring descendants).
 * 
 * Issue: P1 - Keep escalation active after the shell process closes
 * On POSIX with OMC_GRAPH_SIGNAL_CLEANUP=1, a command can spawn a SIGTERM-ignoring
 * descendant with closed/ignored stdio. The shell's close event then fires when the
 * shell dies even though the descendant remains alive; cancelling escalation prevents
 * the promised SIGKILL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('graph signal cleanup escalation timeout regression', () => {
  const originalEnv = process.env.OMC_GRAPH_SIGNAL_CLEANUP;

  beforeEach(() => {
    // Ensure signal cleanup is enabled for these tests
    process.env.OMC_GRAPH_SIGNAL_CLEANUP = '1';
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.OMC_GRAPH_SIGNAL_CLEANUP = originalEnv;
    } else {
      delete process.env.OMC_GRAPH_SIGNAL_CLEANUP;
    }
  });

  it('P1: escalation timeout is not cancelled in close handler', () => {
    // This test verifies the P1 fix by checking that the source code
    // in installGraphSignalCleanup does NOT cancel the escalation timeout
    // when the child process closes.
    //
    // The fix removes the clearTimeout(escalation) call, allowing the timeout
    // to fire independently and send SIGKILL even if descendants survive
    // the shell closure.

    const sourceFile = join(__dirname, '../../src/graph/runtime/executors/command.ts');
    const content = readFileSync(sourceFile, 'utf8');

    // The critical issue: the original code had this pattern:
    //   child.once("close", () => {
    //     clearTimeout(escalation);  // <-- THIS WAS THE BUG
    //     ...
    //   });
    //
    // The fix removes clearTimeout(escalation) so the timeout fires independently

    // Find the signal handler function
    expect(content).toContain('export function installGraphSignalCleanup');

    // Verify the structure: setTimeout with SIGKILL, then child.once("close")
    expect(content).toContain('const _escalation = setTimeout');
    expect(content).toContain('terminateProcessTree(child, "SIGKILL")');
    expect(content).toContain('child.once("close"');

    // The critical check: in the close handler, we should NOT clear the escalation
    // Extract the close handler and verify it doesn't clear escalation
    const closeHandlerSection = content.substring(
      content.indexOf('child.once("close"'),
      content.indexOf('child.once("close"') + 500
    );

    // This pattern would indicate the BUG is present (clearTimeout in close handler)
    expect(closeHandlerSection).not.toContain('clearTimeout(escalation)');
    expect(closeHandlerSection).not.toContain('clearTimeout(_escalation)');

    // The close handler SHOULD still have the standard logic
    expect(closeHandlerSection).toContain('open -= 1');
    expect(closeHandlerSection).toContain('if (open === 0)');

    // Comment in code explains the fix
    expect(content).toContain('Don\'t cancel escalation');
    expect(content).toContain('descendants of the child may still be alive');
  });

  it('escalation timeout is set to fire after KILL_ESCALATION_MS', () => {
    // Verify that the escalation timeout is configured with the correct delay

    const sourceFile = join(__dirname, '../../src/graph/runtime/executors/command.ts');
    const content = readFileSync(sourceFile, 'utf8');

    // The escalation timeout should use KILL_ESCALATION_MS as the delay
    const escalationSetup = content.match(
      /const _escalation = setTimeout\(\(\) => terminateProcessTree\(child, "SIGKILL"\), KILL_ESCALATION_MS\)/
    );
    expect(escalationSetup).toBeTruthy();
  });

  it('KILL_ESCALATION_MS constant is defined', () => {
    // Verify that the grace period constant is defined

    const sourceFile = join(__dirname, '../../src/graph/runtime/executors/command.ts');
    const content = readFileSync(sourceFile, 'utf8');

    expect(content).toContain('const KILL_ESCALATION_MS = 5000');
  });
});
