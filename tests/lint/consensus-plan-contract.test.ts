/**
 * Consensus Plan Contract Test
 *
 * Verifies that the deep-interview → ralplan → autopilot consensus planning chain
 * uses consistent verdict tokens and plan file naming patterns.
 *
 * Issue #5150: Consensus Plan Verdict and Naming Contract Drift
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { describe, it, expect } from 'vitest';

// Get the package root (where agents/ and skills/ folders are)
function getPackageRoot(): string {
  // Start from tests directory and traverse up
  let current = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, 'agents'))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error('Cannot find package root with agents/ folder');
}

const root = getPackageRoot();

/**
 * Plan file naming patterns for consensus mode.
 * Consensus mode plans MUST save to .omc/plans/ralplan-{slug}.md
 */
const CONSENSUS_PLAN_PATTERN = /\.omc\/plans\/ralplan-[a-z0-9-]+\.md/i;

describe('Consensus Plan Contract', () => {
  describe('Verdict Tokens', () => {
    it('critic.md outputs canonical verdict tokens', () => {
      const criticPath = join(root, 'agents', 'critic.md');
      const content = readFileSync(criticPath, 'utf-8');

      // Critic output format MUST include the canonical verdicts
      expect(content).toContain('VERDICT: [REJECT / ITERATE / APPROVE]');

      // These OLD verdict tokens MUST NOT appear in the critic prompt
      expect(content).not.toContain('ACCEPT-WITH-RESERVATIONS');
      expect(content).not.toContain('REVISE');
      
      // Verify no old tokens in the final checklist
      const lines = content.split('\n');
      const verdictLines = lines.filter(l => l.includes('VERDICT') || l.includes('verdict clearly'));
      
      for (const line of verdictLines) {
        // Each verdict line should reference canonical tokens
        if (line.includes('clearly')) {
          expect(line).toContain('REJECT/ITERATE/APPROVE');
        }
      }
    });

    it('plan/SKILL.md documents canonical verdict tokens for review mode', () => {
      const planPath = join(root, 'skills', 'plan', 'SKILL.md');
      const content = readFileSync(planPath, 'utf-8');

      // Plan skill should document the canonical verdicts
      expect(content).toContain('APPROVE, ITERATE');
      expect(content).toContain('REJECT');
      
      // Should NOT contain old verdict words
      expect(content).not.toContain('APPROVED, REVISE, REJECT');
    });

    it('ralplan/SKILL.md uses canonical verdict tokens', () => {
      const ralplanPath = join(root, 'skills', 'ralplan', 'SKILL.md');
      const content = readFileSync(ralplanPath, 'utf-8');

      // Ralplan already branches on the canonical verdicts
      expect(content).toContain('non-`APPROVE` Critic verdict');
      expect(content).toContain('`ITERATE` or `REJECT`');
      expect(content).toContain("Critic returns `APPROVE`");
    });

    it('No consumer code has stale verdict word literals', () => {
      const criticPath = join(root, 'agents', 'critic.md');
      const criticContent = readFileSync(criticPath, 'utf-8');

      // The OLD output format line should not exist
      expect(criticContent).not.toContain('VERDICT: [REJECT / REVISE / ACCEPT-WITH-RESERVATIONS / ACCEPT]');

      // The OLD final checklist line should not exist
      expect(criticContent).not.toContain('Is my verdict clearly stated (REJECT/REVISE/ACCEPT-WITH-RESERVATIONS/ACCEPT)?');
    });
  });

  describe('Plan File Naming', () => {
    it('planner.md documents consensus mode uses ralplan- prefix', () => {
      const plannerPath = join(root, 'agents', 'planner.md');
      const content = readFileSync(plannerPath, 'utf-8');

      // Planner should document the naming convention
      expect(content).toContain('ralplan-{slug}.md');
      
      // Should mention consensus mode specifically
      expect(content).toContain('consensus mode');
    });

    it('plan/SKILL.md documents consensus plan naming pattern', () => {
      const planPath = join(root, 'skills', 'plan', 'SKILL.md');
      const content = readFileSync(planPath, 'utf-8');

      // Plan skill should document the naming pattern
      expect(content).toContain('ralplan-{slug}.md');
      expect(content).toContain('Consensus/ralplan mode');
    });

    it('autopilot/SKILL.md detects ralplan consensus plans', () => {
      const autopilotPath = join(root, 'skills', 'autopilot', 'SKILL.md');
      const content = readFileSync(autopilotPath, 'utf-8');

      // Autopilot should detect the ralplan pattern
      expect(content).toContain('.omc/plans/ralplan-*.md');
      
      // Should also accept the old consensus- pattern for backward compatibility
      expect(content).toContain('.omc/plans/consensus-*.md');
    });
  });

  describe('Contract Consistency', () => {
    it('all files reference the same canonical verdict set', () => {
      const criticPath = join(root, 'agents', 'critic.md');
      const planPath = join(root, 'skills', 'plan', 'SKILL.md');
      const ralplanPath = join(root, 'skills', 'ralplan', 'SKILL.md');

      const criticContent = readFileSync(criticPath, 'utf-8');
      const planContent = readFileSync(planPath, 'utf-8');
      const ralplanContent = readFileSync(ralplanPath, 'utf-8');

      // All files should reference APPROVE
      expect(criticContent).toContain('APPROVE');
      expect(planContent).toContain('APPROVE');
      expect(ralplanContent).toContain('APPROVE');

      // All files should reference ITERATE
      expect(criticContent).toContain('ITERATE');
      expect(planContent).toContain('ITERATE');
      expect(ralplanContent).toContain('ITERATE');

      // All files should reference REJECT
      expect(criticContent).toContain('REJECT');
      expect(planContent).toContain('REJECT');
      expect(ralplanContent).toContain('REJECT');
    });

    it('Plan file naming is consistent across documentation', () => {
      const plannerPath = join(root, 'agents', 'planner.md');
      const planPath = join(root, 'skills', 'plan', 'SKILL.md');
      const autopilotPath = join(root, 'skills', 'autopilot', 'SKILL.md');

      const plannerContent = readFileSync(plannerPath, 'utf-8');
      const planContent = readFileSync(planPath, 'utf-8');
      const autopilotContent = readFileSync(autopilotPath, 'utf-8');

      // All files should reference the ralplan- pattern for consensus
      expect(plannerContent).toContain('ralplan-');
      expect(planContent).toContain('ralplan-');
      expect(autopilotContent).toContain('ralplan-*.md');
    });
  });

  describe('No Drift in Documentation', () => {
    it('critic.md has no contradictory verdict documentation', () => {
      const criticPath = join(root, 'agents', 'critic.md');
      const content = readFileSync(criticPath, 'utf-8');

      // Should not have any line saying "ACCEPT" as a verdict
      const lines = content.split('\n');
      const verdictLines = lines.filter(l => /verdict/i.test(l) && /ACCEPT/.test(l));
      
      // If there are any ACCEPT mentions, they should only be in old comments
      // (which should have been removed)
      expect(verdictLines).toHaveLength(0);
    });

    it('No hardcoded old verdict strings in criticism logic', () => {
      const criticPath = join(root, 'agents', 'critic.md');
      const content = readFileSync(criticPath, 'utf-8');

      // Should never mention REVISE in context of critic verdict
      const revisingLines = content.split('\n').filter(l => 
        /revise/i.test(l) && !l.includes('Request changes') && !l.includes('revision')
      );
      
      // If there are "revise" mentions, they should not be verdicts
      for (const line of revisingLines) {
        // Only allow if it's about the author revising, not critic saying REVISE
        expect(line).not.toMatch(/verdict.*revise/i);
        expect(line).not.toMatch(/REVISE/);
      }
    });
  });

  describe('Autopilot Plan Detection', () => {
    it('detects ralplan-*.md files for consensus plans', () => {
      // This test ensures the pattern in autopilot matches what
      // planner and plan skill instruct
      const pattern = CONSENSUS_PLAN_PATTERN;
      
      const testPaths = [
        '.omc/plans/ralplan-auth-system.md',
        '.omc/plans/ralplan-database-migration.md',
        '.omc/plans/ralplan-api-v2.md',
      ];

      for (const testPath of testPaths) {
        expect(testPath).toMatch(pattern);
      }
    });

    it('rejects invalid plan file names for consensus', () => {
      // These should NOT match the consensus plan pattern
      const pattern = CONSENSUS_PLAN_PATTERN;

      // autopilot-impl.md is valid but for direct mode
      expect('.omc/plans/autopilot-impl.md').not.toMatch(pattern);
      
      // plan- prefix is not ralplan pattern
      expect('.omc/plans/plan-auth.md').not.toMatch(pattern);
    });
  });
});
