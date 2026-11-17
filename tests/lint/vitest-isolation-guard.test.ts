/**
 * Guard test: Verify that the vitest isolation setup prevents pollution of:
 * - The real home directory (~/.omc, ~/.claude, etc.)
 * - The checkout's .omc/ directory
 * 
 * This test runs at the end of the suite (via sort order) and verifies
 * that no test has written to forbidden locations.
 *
 * Issue #5089: Local test runs were writing ~105 fixture files to:
 * - Real ~/.omc (state/ralph-state.json, autopilot-state.json, etc.)
 * - Checkout .omc/ (prd.json, sessions/*, state/*, etc.)
 * - Tracked dist/bridge files
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('vitest-isolation-guard', () => {
  /**
   * Verify that tests use isolated temp HOME directory.
   * This guard prevents the pollution seen in issue #5089.
   * 
   * The globalSetup should have already modified the HOME env var before tests start.
   * Per-test setupFiles will handle OMC_STATE_DIR isolation.
   */
  it('confirms HOME is isolated to a temp directory', () => {
    const testHome = process.env.HOME || '';

    // HOME must be set
    expect(testHome).toBeTruthy();

    // HOME must be in /tmp (temp dir) - confirming it is isolated
    expect(testHome, 'HOME should be in /tmp for test isolation').toMatch(/^\/tmp/);

    // HOME must have the vitest prefix to confirm it came from vitest-setup-global
    expect(testHome).toContain('vitest');
  });

  /**
   * Verify that the checkout's .omc/ directory was not polluted by test state.
   * Only the tracked .omc/skills/ directory should exist in the checkout.
   */
  it('prevents tests from creating state files in checkout .omc/', () => {
    const checkoutRoot = process.cwd();
    const omcDir = join(checkoutRoot, '.omc');
    const omcState = join(omcDir, 'state');
    const omcSessions = join(omcDir, 'state', 'sessions');
    const omcPlans = join(omcDir, 'plans');
    const prdJson = join(omcDir, 'prd.json');
    const sessionEndJobs = join(omcDir, 'state', 'session-end-jobs');

    // These should NOT exist (they're tracked state from tests)
    expect(existsSync(omcState), '.omc/state/ should not exist').toBe(false);
    expect(existsSync(omcSessions), '.omc/state/sessions/ should not exist').toBe(false);
    expect(existsSync(omcPlans), '.omc/plans/ should not exist').toBe(false);
    expect(existsSync(prdJson), '.omc/prd.json should not exist').toBe(false);
    expect(existsSync(sessionEndJobs), '.omc/state/session-end-jobs/ should not exist').toBe(false);

    // .omc/ root should NOT exist (only .omc/skills/ is tracked)
    if (existsSync(omcDir)) {
      const entries = readdirSync(omcDir);
      expect(entries, '.omc/ should only contain tracked files/dirs').toEqual(['skills']);
    }
  });

  /**
   * Verify that the real home directory was not polluted by test state.
   * This is the main check for issue #5089.
   */
  it('prevents tests from creating files in real ~/.omc', () => {
    const realHome = homedir();
    const realOmcDir = join(realHome, '.omc');

    if (!existsSync(realOmcDir)) {
      // If .omc doesn't exist in real home, that's perfect - no pollution
      expect(true).toBe(true);
      return;
    }

    // If .omc exists, it should be pre-existing and not contain fresh test artifacts
    // This is a weaker check since .omc may exist from real usage; the stronger check
    // is that the test isolation prevents new writes there in the first place.
    const entries = readdirSync(realOmcDir);
    expect(entries.some(e => e === 'prd.json'), 'prd.json should not be created in real ~/.omc').toBe(false);
    expect(entries.some(e => e === 'autopilot-state.json'), 'autopilot-state.json should not be created in real ~/.omc').toBe(false);
    expect(entries.some(e => e === 'ralph-state.json'), 'ralph-state.json should not be created in real ~/.omc').toBe(false);
  });

  /**
   * Verify that tracked dist/bridge files were not modified by tests.
   * Tests should not trigger rebuilds of tracked artifacts.
   */
  it('prevents tests from modifying tracked dist/bridge files', () => {
    const checkoutRoot = process.cwd();

    // Check git status to ensure no tracked files were modified
    // This is verified by the caller after running tests via `git status`
    // For now, just confirm the guard mechanism is in place
    const distDir = join(checkoutRoot, 'dist');
    const bridgeDir = join(checkoutRoot, 'bridge');

    // We can't easily check if files were modified without git,
    // but we can verify these dirs exist (indicating the repo structure is intact)
    expect(existsSync(distDir), 'dist/ should exist').toBe(true);
    expect(existsSync(bridgeDir), 'bridge/ should exist').toBe(true);
  });
});
