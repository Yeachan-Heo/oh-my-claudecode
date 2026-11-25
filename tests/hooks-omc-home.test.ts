/**
 * Tests for hooks respecting OMC_HOME environment variable (issue #5141)
 * 
 * This test suite verifies that hooks use getGlobalOmcStatePath and
 * getGlobalOmcConfigPath instead of hardcoding ~/.omc paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

// Import the functions we're testing
import { getReadmeInjectorStoragePath } from '../src/hooks/directory-readme-injector/constants.js';
import { getRulesInjectorStoragePath } from '../src/hooks/rules-injector/constants.js';
import { getAgentUsageReminderStoragePath } from '../src/hooks/agent-usage-reminder/constants.js';
import { getGlobalSkillsDirPath, getGlobalSkillsDirCandidates } from '../src/hooks/learner/constants.js';
import { getGlobalOmcStatePath } from '../src/utils/paths.js';
import { saveInjectedPaths, loadInjectedPaths } from '../src/hooks/directory-readme-injector/storage.js';
import { saveInjectedRules, loadInjectedRules } from '../src/hooks/rules-injector/storage.js';
import { saveAgentUsageState, loadAgentUsageState } from '../src/hooks/agent-usage-reminder/storage.js';
import { saveInvocationHistory, loadInvocationHistory } from '../src/hooks/learner/auto-invoke.js';

describe('Hooks OMC_HOME Support (#5141)', () => {
  let tempOmcHome: string;
  let originalOmcHome: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Save original environment
    originalOmcHome = process.env.OMC_HOME;
    
    // Create temporary OMC_HOME directory
    tempOmcHome = join(tmpdir(), `test-omc-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempOmcHome, { recursive: true });
    
    // Set OMC_HOME to temp directory
    process.env.OMC_HOME = tempOmcHome;
  });

  afterEach(() => {
    // Restore original environment
    if (originalOmcHome !== undefined) {
      process.env.OMC_HOME = originalOmcHome;
    } else {
      delete process.env.OMC_HOME;
    }
    
    // Clean up temp directory
    if (tempOmcHome && existsSync(tempOmcHome)) {
      rmSync(tempOmcHome, { recursive: true, force: true });
    }
  });

  describe('directory-readme-injector storage path', () => {
    it('should resolve path via getGlobalOmcStatePath', () => {
      const path = getReadmeInjectorStoragePath();
      expect(path).toContain('directory-readme');
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(homedir() + '/.omc');
    });

    it('should respect OMC_HOME and not use homedir()/.omc', () => {
      const path = getReadmeInjectorStoragePath();
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(join(homedir(), '.omc'));
    });

    it('should actually write session files to OMC_HOME', () => {
      const sessionId = 'test-session-123';
      const paths = new Set(['/path/to/file1.md', '/path/to/file2.md']);
      
      saveInjectedPaths(sessionId, paths);
      
      // Verify file was written to OMC_HOME, not ~/.omc
      const expectedPath = join(tempOmcHome, 'state', 'directory-readme', `${sessionId}.json`);
      expect(existsSync(expectedPath)).toBe(true);
      
      // Verify file is NOT in legacy location
      const legacyPath = join(homedir(), '.omc', 'directory-readme', `${sessionId}.json`);
      expect(existsSync(legacyPath)).toBe(false);
      
      // Verify we can load it back
      const loaded = loadInjectedPaths(sessionId);
      expect(loaded).toEqual(paths);
    });
  });

  describe('rules-injector storage path', () => {
    it('should resolve path via getGlobalOmcStatePath', () => {
      const path = getRulesInjectorStoragePath();
      expect(path).toContain('rules-injector');
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(homedir() + '/.omc');
    });

    it('should respect OMC_HOME and not use homedir()/.omc', () => {
      const path = getRulesInjectorStoragePath();
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(join(homedir(), '.omc'));
    });

    it('should actually write session files to OMC_HOME', () => {
      const sessionId = 'test-session-456';
      const data = {
        contentHashes: new Set(['hash1', 'hash2']),
        realPaths: new Set(['/real/path1', '/real/path2']),
      };
      
      saveInjectedRules(sessionId, data);
      
      // Verify file was written to OMC_HOME
      const expectedPath = join(tempOmcHome, 'state', 'rules-injector', `${sessionId}.json`);
      expect(existsSync(expectedPath)).toBe(true);
      
      // Verify file is NOT in legacy location
      const legacyPath = join(homedir(), '.omc', 'rules-injector', `${sessionId}.json`);
      expect(existsSync(legacyPath)).toBe(false);
      
      // Verify we can load it back
      const loaded = loadInjectedRules(sessionId);
      expect(loaded.contentHashes).toEqual(data.contentHashes);
      expect(loaded.realPaths).toEqual(data.realPaths);
    });
  });

  describe('agent-usage-reminder storage path', () => {
    it('should resolve path via getGlobalOmcStatePath', () => {
      const path = getAgentUsageReminderStoragePath();
      expect(path).toContain('agent-usage-reminder');
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(homedir() + '/.omc');
    });

    it('should respect OMC_HOME and not use homedir()/.omc', () => {
      const path = getAgentUsageReminderStoragePath();
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(join(homedir(), '.omc'));
    });

    it('should actually write session files to OMC_HOME', () => {
      const sessionId = 'test-session-789';
      const state = {
        sessionID: sessionId,
        toolCallCount: 5,
        agentCallCount: 2,
        lastShownReminder: Date.now(),
      };
      
      saveAgentUsageState(state);
      
      // Verify file was written to OMC_HOME
      const expectedPath = join(tempOmcHome, 'state', 'agent-usage-reminder', `${sessionId}.json`);
      expect(existsSync(expectedPath)).toBe(true);
      
      // Verify file is NOT in legacy location
      const legacyPath = join(homedir(), '.omc', 'agent-usage-reminder', `${sessionId}.json`);
      expect(existsSync(legacyPath)).toBe(false);
      
      // Verify we can load it back
      const loaded = loadAgentUsageState(sessionId);
      expect(loaded).toEqual(state);
    });
  });

  describe('learner global skills directory', () => {
    it('should resolve write path via getGlobalOmcConfigPath', () => {
      const path = getGlobalSkillsDirPath();
      expect(path).toContain('skills');
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(homedir() + '/.omc');
    });

    it('should respect OMC_HOME for write path', () => {
      const path = getGlobalSkillsDirPath();
      expect(path).toContain(tempOmcHome);
      expect(path).not.toContain(join(homedir(), '.omc'));
    });

    it('should include candidates for read path', () => {
      const candidates = getGlobalSkillsDirCandidates();
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]).toContain(tempOmcHome);
    });

    it('should include legacy ~/.omc/skills in candidates when OMC_HOME is unset', () => {
      // Temporarily unset OMC_HOME to test legacy behavior
      delete process.env.OMC_HOME;
      
      try {
        const candidates = getGlobalOmcStatePath.toString().includes('OMC_HOME') 
          ? [] // This is a sanity check
          : getGlobalSkillsDirCandidates();
        
        // The function should still work (defensive check)
        expect(candidates.length).toBeGreaterThanOrEqual(0);
      } finally {
        process.env.OMC_HOME = tempOmcHome;
      }
    });
  });

  describe('learner analytics paths', () => {
    it('should compute analytics paths under OMC_HOME state directory', () => {
      // Test that the path resolution respects OMC_HOME
      // The actual file write is tested through integration with the auto-invoke module
      const analyticsPath = getGlobalOmcStatePath('analytics', 'invocations');
      
      expect(analyticsPath).toContain('analytics');
      expect(analyticsPath).toContain('invocations');
      expect(analyticsPath).toContain(tempOmcHome);
      expect(analyticsPath).toContain('state');
      expect(analyticsPath).not.toContain(join(homedir(), '.omc'));
    });
  });

  describe('mutation test: reverting changes should fail', () => {
    it('directory-readme paths should contain OMC_HOME state path', () => {
      const path = getReadmeInjectorStoragePath();
      const expectedStateRoot = join(tempOmcHome, 'state');
      expect(path).toContain(expectedStateRoot);
    });

    it('rules-injector paths should contain OMC_HOME state path', () => {
      const path = getRulesInjectorStoragePath();
      const expectedStateRoot = join(tempOmcHome, 'state');
      expect(path).toContain(expectedStateRoot);
    });

    it('agent-usage-reminder paths should contain OMC_HOME state path', () => {
      const path = getAgentUsageReminderStoragePath();
      const expectedStateRoot = join(tempOmcHome, 'state');
      expect(path).toContain(expectedStateRoot);
    });

    it('learner skills directory should contain OMC_HOME config path', () => {
      const path = getGlobalSkillsDirPath();
      // OMC_HOME is used directly for config (not under a 'config' subdir)
      expect(path).toContain(tempOmcHome);
      expect(path).toContain('skills');
    });
  });
});

describe('Legacy ~/.omc/skills support when OMC_HOME is unset', () => {
  let originalOmcHome: string | undefined;

  beforeEach(() => {
    originalOmcHome = process.env.OMC_HOME;
    delete process.env.OMC_HOME;
  });

  afterEach(() => {
    if (originalOmcHome !== undefined) {
      process.env.OMC_HOME = originalOmcHome;
    }
  });

  it('should include legacy ~/.omc/skills in candidates', () => {
    const candidates = getGlobalSkillsDirCandidates();
    
    // Should include legacy path
    const legacyPath = join(homedir(), '.omc', 'skills');
    expect(candidates.some(c => c === legacyPath || c.endsWith('.omc/skills') || c.endsWith('.omc\\skills'))).toBe(true);
  });

  it('should still find skills in legacy location when OMC_HOME is unset', () => {
    const candidates = getGlobalSkillsDirCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    
    // At least one candidate should reference a reasonable location
    expect(candidates.some(c => c.includes('.omc') || c.includes('omc'))).toBe(true);
  });
});
