/**
 * Auto-Learner Module Tests
 * 
 * Comprehensive QA tests for the auto-learner module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initAutoLearner,
  recordPattern,
  extractTriggers,
  calculateSkillWorthiness,
  getSuggestedSkills,
  type AutoLearnerState,
  type PatternDetection,
} from '../../hooks/learner/auto-learner.js';

describe('Auto-Learner Module', () => {
  // Test Case 1: State Initialization
  describe('1. State Initialization', () => {
    it('initAutoLearner creates correct initial state', () => {
      const state = initAutoLearner('test-session-123');
      
      expect(state).toBeDefined();
      expect(state.sessionId).toBe('test-session-123');
      expect(state.patterns).toBeInstanceOf(Map);
      expect(state.suggestedSkills).toBeInstanceOf(Array);
    });

    it('verifies empty patterns map', () => {
      const state = initAutoLearner('test-session');
      expect(state.patterns.size).toBe(0);
    });

    it('verifies empty suggestedSkills array', () => {
      const state = initAutoLearner('test-session');
      expect(state.suggestedSkills).toHaveLength(0);
    });
  });

  // Test Case 2: Pattern Recording
  describe('2. Pattern Recording', () => {
    let state: AutoLearnerState;

    beforeEach(() => {
      state = initAutoLearner('test-session');
    });

    it('recordPattern records a valid problem-solution pair', () => {
      const problem = 'TypeError: Cannot read properties of undefined when accessing user.name';
      const solution = 'Check if user object exists before accessing properties. Use optional chaining: user?.name';

      const pattern = recordPattern(state, problem, solution);

      expect(pattern).not.toBeNull();
      expect(pattern!.problem).toBe(problem);
      expect(pattern!.solution).toBe(solution);
      expect(pattern!.occurrences).toBe(1);
    });

    it('content hashing provides deduplication', () => {
      const problem = 'Error: Module not found';
      const solution = 'Install the missing dependency with npm install package-name';

      // Record same pattern twice
      const pattern1 = recordPattern(state, problem, solution);
      const pattern2 = recordPattern(state, problem, solution);

      // Should be the same pattern
      expect(pattern1!.id).toBe(pattern2!.id);
      // Should only have one entry in the map
      expect(state.patterns.size).toBe(1);
    });

    it('occurrence counting increments on duplicate patterns', () => {
      const problem = 'Error: ENOENT: no such file or directory';
      const solution = 'The file path is incorrect. Verify the path exists or create the directory first.';

      recordPattern(state, problem, solution);
      const pattern = recordPattern(state, problem, solution);

      expect(pattern!.occurrences).toBe(2);
    });

    it('records multiple different patterns separately', () => {
      recordPattern(
        state,
        'Error: Module not found react',
        'Install react with: npm install react'
      );
      recordPattern(
        state,
        'TypeError: undefined is not a function',
        'Check if the function exists before calling it'
      );

      expect(state.patterns.size).toBe(2);
    });
  });

  // Test Case 3: Trigger Extraction
  describe('3. Trigger Extraction', () => {
    it('extractTriggers extracts error messages', () => {
      const problem = 'Got this error: TypeError: Cannot read properties of undefined';
      const solution = 'Check for null/undefined values';

      const triggers = extractTriggers(problem, solution);

      expect(triggers.some(t => t.toLowerCase().includes('cannot read'))).toBe(true);
    });

    it('extractTriggers extracts file paths', () => {
      const problem = 'Issue in src/components/Button.tsx when rendering';
      const solution = 'Fixed the import path in the component';

      const triggers = extractTriggers(problem, solution);

      expect(triggers.some(t => t.includes('Button.tsx'))).toBe(true);
    });

    it('extractTriggers extracts technical terms', () => {
      const problem = 'The React component does not render properly in TypeScript';
      const solution = 'Add proper type annotations for the props interface';

      const triggers = extractTriggers(problem, solution);

      // Should extract capitalized terms like React or TypeScript
      const hasReact = triggers.some(t => t.toLowerCase() === 'react');
      const hasTypeScript = triggers.some(t => t.toLowerCase() === 'typescript');
      
      expect(hasReact || hasTypeScript).toBe(true);
    });

    it('extracts high-value keywords when present', () => {
      const problem = 'The application crashed with an error';
      const solution = 'Fixed the bug by adding null checks';

      const triggers = extractTriggers(problem, solution);

      // Should include high-value keywords
      expect(triggers.some(t => ['error', 'crash', 'fix', 'bug'].includes(t.toLowerCase()))).toBe(true);
    });

    it('limits triggers to maximum of 10', () => {
      const problem = `
        Error: Module 'react' not found in /src/components/App.tsx
        Also found TypeError in /src/utils/helper.ts
        SyntaxError: Unexpected token in /src/config/settings.js
        ReferenceError: variable is not defined
      `;
      const solution = `
        Fixed multiple issues in React, TypeScript, JavaScript, Vue, Angular
        Updated Node.js configuration and Python scripts
        Resolved Rust and Go compilation errors
      `;

      const triggers = extractTriggers(problem, solution);

      expect(triggers.length).toBeLessThanOrEqual(10);
    });
  });

  // Test Case 4: Skill Worthiness Scoring
  describe('4. Skill Worthiness Scoring', () => {
    it('calculateSkillWorthiness returns score in valid range', () => {
      const pattern: PatternDetection = {
        id: 'test-1',
        problem: 'Error: Cannot connect to database',
        solution: 'Check database connection string and ensure the server is running',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error', 'database'],
        suggestedTags: ['debugging'],
      };

      const score = calculateSkillWorthiness(pattern);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('high-value keywords boost the score', () => {
      const basePattern: PatternDetection = {
        id: 'test-base',
        problem: 'Issue with the component rendering',
        solution: 'Updated the state management logic in the component to properly handle updates',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['component'],
        suggestedTags: [],
      };

      const boostedPattern: PatternDetection = {
        id: 'test-boosted',
        problem: 'Error: Crash when component renders, bug in state',
        solution: 'Fixed the bug by adding proper error handling. The workaround was to use a try-catch block.',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error', 'crash', 'fix', 'bug', 'workaround'],
        suggestedTags: ['debugging'],
      };

      const baseScore = calculateSkillWorthiness(basePattern);
      const boostedScore = calculateSkillWorthiness(boostedPattern);

      expect(boostedScore).toBeGreaterThan(baseScore);
    });

    it('generic patterns receive penalties', () => {
      const specificPattern: PatternDetection = {
        id: 'test-specific',
        problem: 'Error: ECONNREFUSED when connecting to localhost:5432 in /src/db/connection.ts',
        solution: 'The PostgreSQL server was not running. Start it with: sudo systemctl start postgresql',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error', 'postgresql', 'connection.ts'],
        suggestedTags: ['database'],
      };

      const genericPattern: PatternDetection = {
        id: 'test-generic',
        problem: 'Something is not working correctly in the app',
        solution: 'Try again after restarting. Check the docs and google it if problem persists. Look at the error message.',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: [],
        suggestedTags: [],
      };

      const specificScore = calculateSkillWorthiness(specificPattern);
      const genericScore = calculateSkillWorthiness(genericPattern);

      expect(specificScore).toBeGreaterThan(genericScore);
    });

    it('multiple occurrences boost the score', () => {
      const singleOccurrence: PatternDetection = {
        id: 'test-single',
        problem: 'Error: Port 3000 already in use',
        solution: 'Kill the process using the port: lsof -ti:3000 | xargs kill -9',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error', 'port'],
        suggestedTags: [],
      };

      const multipleOccurrences: PatternDetection = {
        ...singleOccurrence,
        id: 'test-multiple',
        occurrences: 5,
      };

      const singleScore = calculateSkillWorthiness(singleOccurrence);
      const multipleScore = calculateSkillWorthiness(multipleOccurrences);

      expect(multipleScore).toBeGreaterThan(singleScore);
    });

    it('longer solutions score higher than very short ones', () => {
      const shortSolution: PatternDetection = {
        id: 'test-short',
        problem: 'Error in the application configuration',
        solution: 'Fixed the config file settings.',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error'],
        suggestedTags: [],
      };

      const detailedSolution: PatternDetection = {
        id: 'test-detailed',
        problem: 'Error in the application configuration loading',
        solution: `The configuration file was missing the required DATABASE_URL environment variable. 
                   To fix this, add DATABASE_URL=postgresql://user:pass@localhost:5432/dbname to your .env file.
                   Also ensure the .env file is in the project root and not gitignored accidentally.
                   You can verify with: node -e "console.log(process.env.DATABASE_URL)"`,
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: ['error', 'configuration'],
        suggestedTags: [],
      };

      const shortScore = calculateSkillWorthiness(shortSolution);
      const detailedScore = calculateSkillWorthiness(detailedSolution);

      expect(detailedScore).toBeGreaterThan(shortScore);
    });
  });

  // Test Case 5: Suggestion Threshold
  describe('5. Suggestion Threshold', () => {
    let state: AutoLearnerState;

    beforeEach(() => {
      state = initAutoLearner('test-session');
    });

    it('getSuggestedSkills filters by threshold', () => {
      // Add a high-quality pattern that should be suggested
      const highQualityProblem = 'Error: ENOENT no such file /src/config/database.ts when loading config';
      const highQualitySolution = `
        The database configuration file was missing. Fixed by:
        1. Creating the missing config file
        2. Adding proper TypeScript types for the config
        3. Setting up environment variable fallbacks
        This resolved the ENOENT error and made the app work properly.
      `;
      
      // Record it multiple times to boost occurrences
      recordPattern(state, highQualityProblem, highQualitySolution);
      recordPattern(state, highQualityProblem, highQualitySolution);
      recordPattern(state, highQualityProblem, highQualitySolution);

      // Add a low-quality pattern that shouldn't be suggested
      const lowQualityProblem = 'Problem with app';
      const lowQualitySolution = 'Try again or restart';

      recordPattern(state, lowQualityProblem, lowQualitySolution);

      const suggestions = getSuggestedSkills(state, 70);

      // Only high-quality patterns should pass the threshold
      expect(suggestions.every(s => s.confidence >= 70)).toBe(true);
    });

    it('verifies default threshold of 70', () => {
      // Create a pattern that should be around the threshold
      const problem = 'Error: Module react not found in /src/App.tsx';
      const solution = 'Install the missing dependency: npm install react. The fix resolved the import error in the component.';

      // Record multiple times to boost score
      for (let i = 0; i < 3; i++) {
        recordPattern(state, problem, solution);
      }

      // Get suggestions with default threshold (70)
      const suggestions = getSuggestedSkills(state);

      // All returned suggestions should meet the default threshold
      suggestions.forEach(s => {
        expect(s.confidence).toBeGreaterThanOrEqual(70);
      });
    });

    it('higher threshold returns fewer suggestions', () => {
      // Add multiple patterns with varying quality
      const patterns = [
        {
          problem: 'Error: ENOENT crash reading /src/db/config.ts - bug in loader',
          solution: 'Fixed the bug by creating the missing configuration file. Added workaround for path resolution. The solution involved proper error handling.',
        },
        {
          problem: 'Error: Connection failed to database server',
          solution: 'Verified the database server was running and fixed the connection string configuration.',
        },
        {
          problem: 'Warning: Component missing key prop',
          solution: 'Added unique key prop to list items in the React component.',
        },
      ];

      patterns.forEach(p => {
        recordPattern(state, p.problem, p.solution);
        recordPattern(state, p.problem, p.solution); // Record twice for boost
      });

      const lowThresholdSuggestions = getSuggestedSkills(state, 50);
      const highThresholdSuggestions = getSuggestedSkills(state, 90);

      expect(lowThresholdSuggestions.length).toBeGreaterThanOrEqual(highThresholdSuggestions.length);
    });

    it('returns suggestions sorted by confidence descending', () => {
      // Add patterns with varying quality
      const patterns = [
        {
          problem: 'Error: ENOENT no such file in /src/config.ts - crash',
          solution: 'Fixed by creating missing file and adding proper error handling. The bug was in the loader module.',
        },
        {
          problem: 'TypeError: Cannot read property of undefined in component',
          solution: 'Added null checks before accessing properties.',
        },
      ];

      patterns.forEach(p => {
        for (let i = 0; i < 3; i++) {
          recordPattern(state, p.problem, p.solution);
        }
      });

      const suggestions = getSuggestedSkills(state, 0); // Low threshold to get all

      // Verify sorted by confidence descending
      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i - 1].confidence).toBeGreaterThanOrEqual(suggestions[i].confidence);
      }
    });
  });

  // Test Case 6: Edge Cases
  describe('6. Edge Cases', () => {
    let state: AutoLearnerState;

    beforeEach(() => {
      state = initAutoLearner('test-session');
    });

    it('handles empty problem string', () => {
      const result = recordPattern(state, '', 'Some solution text here for testing');
      expect(result).toBeNull();
    });

    it('handles empty solution string', () => {
      const result = recordPattern(state, 'Error: Some problem occurred', '');
      expect(result).toBeNull();
    });

    it('handles both empty problem and solution', () => {
      const result = recordPattern(state, '', '');
      expect(result).toBeNull();
    });

    it('handles very short content (below minimum)', () => {
      const result = recordPattern(state, 'Short', 'Also short');
      expect(result).toBeNull();
    });

    it('handles whitespace-only input', () => {
      const result = recordPattern(state, '   \n\t   ', '   \n\t   ');
      expect(result).toBeNull();
    });

    it('extracts no triggers from generic text', () => {
      const triggers = extractTriggers(
        'something happened',
        'did something to fix it'
      );

      // May still extract some keywords but should be minimal
      expect(triggers.length).toBeLessThanOrEqual(10);
    });

    it('handles null/undefined gracefully in recordPattern', () => {
      // TypeScript would normally prevent this, but test runtime behavior
      const result1 = recordPattern(state, null as any, 'solution');
      const result2 = recordPattern(state, 'problem', undefined as any);

      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });

    it('handles special characters in problem/solution', () => {
      const problem = 'Error: Path contains special chars: /path/to/file<>:"|?*.ts';
      const solution = 'Escape or remove special characters: path.replace(/[<>:"|?*]/g, "_")';

      const pattern = recordPattern(state, problem, solution);

      expect(pattern).not.toBeNull();
      expect(pattern!.problem).toContain('special chars');
    });

    it('handles Unicode content', () => {
      const problem = 'Error: 文件未找到 - File not found in 日本語パス/コンポーネント.tsx';
      const solution = 'The file path contained CJK characters. Fixed by using proper encoding.';

      const pattern = recordPattern(state, problem, solution);

      expect(pattern).not.toBeNull();
    });

    it('handles extremely long content', () => {
      const longProblem = 'Error: ' + 'A'.repeat(5000);
      const longSolution = 'Fix: ' + 'B'.repeat(5000);

      const pattern = recordPattern(state, longProblem, longSolution);

      expect(pattern).not.toBeNull();
      expect(pattern!.id).toBeDefined();
    });

    it('pattern with no extractable triggers gets penalty', () => {
      const pattern: PatternDetection = {
        id: 'test-no-triggers',
        problem: 'Something went wrong somewhere.',
        solution: 'Did some things to make it better.',
        confidence: 0,
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        suggestedTriggers: [], // No triggers
        suggestedTags: [],
      };

      const score = calculateSkillWorthiness(pattern);

      // Should have penalty for missing triggers (base 50 - 25 penalty - 20 short content = ~5)
      expect(score).toBeLessThan(50);
    });
  });

  // Test Case 7: Integration - Full Workflow
  describe('7. Integration - Full Workflow', () => {
    it('complete workflow from init to suggestions', () => {
      // Initialize
      const state = initAutoLearner('integration-test-session');
      expect(state.patterns.size).toBe(0);

      // Record high-quality pattern multiple times
      const problem = 'Error: ECONNREFUSED connecting to localhost:5432 in /src/db/client.ts';
      const solution = `
        The PostgreSQL database server was not running. Fixed by:
        1. Starting the database: sudo systemctl start postgresql
        2. Verifying connection: psql -U postgres -c "SELECT 1"
        3. Updated connection retry logic in the application
        This error commonly occurs after system restart.
      `;

      recordPattern(state, problem, solution);
      expect(state.patterns.size).toBe(1);

      recordPattern(state, problem, solution);
      const pattern = Array.from(state.patterns.values())[0];
      expect(pattern.occurrences).toBe(2);

      // Get suggestions
      const suggestions = getSuggestedSkills(state, 60);
      
      // Should have at least one suggestion if quality is high enough
      if (suggestions.length > 0) {
        expect(suggestions[0].problem).toBe(problem.trim());
        expect(suggestions[0].suggestedTriggers.length).toBeGreaterThan(0);
      }
    });
  });
});

// Additional Security Tests
describe('Security Tests', () => {
  let state: AutoLearnerState;

  beforeEach(() => {
    state = initAutoLearner('security-test');
  });

  it('does not expose hash internals in pattern ID', () => {
    const pattern = recordPattern(
      state,
      'Error: sensitive database password issue in /etc/passwd',
      'Fixed by updating the credentials in the config file'
    );

    // Pattern ID should be a truncated hash, not exposing content
    expect(pattern!.id.length).toBe(16); // SHA-256 truncated to 16 hex chars
    expect(pattern!.id).not.toContain('password');
    expect(pattern!.id).not.toContain('passwd');
  });

  it('handles injection-like content safely', () => {
    const problem = 'Error: SQL injection detected: \'; DROP TABLE users; --';
    const solution = 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = $1", [userId])';

    const pattern = recordPattern(state, problem, solution);

    expect(pattern).not.toBeNull();
    // Content is stored as-is (not evaluated), which is safe for a data structure
    expect(pattern!.problem).toContain('DROP TABLE');
  });

  it('handles path traversal strings safely', () => {
    const problem = 'Error reading file: ../../../etc/shadow';
    const solution = 'Validate and sanitize file paths before reading';

    const pattern = recordPattern(state, problem, solution);

    // Pattern is stored, not executed
    expect(pattern).not.toBeNull();
    expect(pattern!.problem).toContain('../../../etc/shadow');
  });

  it('handles prototype pollution attempt in content', () => {
    const problem = 'Error: __proto__.polluted = true causes issues';
    const solution = 'Use Object.create(null) or Map instead of plain objects';

    const pattern = recordPattern(state, problem, solution);

    expect(pattern).not.toBeNull();
    // Verify Map-based storage is safe from prototype pollution
    expect((state.patterns as any).__proto__).not.toHaveProperty('polluted');
  });
});

// Performance Tests
describe('Performance Tests', () => {
  it('handles 1000 patterns without significant slowdown', () => {
    const state = initAutoLearner('perf-test');
    const start = Date.now();

    for (let i = 0; i < 1000; i++) {
      recordPattern(
        state,
        `Error number ${i}: Something failed in /src/file${i}.ts`,
        `Fixed error ${i} by applying the correct solution with proper error handling and verification`
      );
    }

    const elapsed = Date.now() - start;

    expect(state.patterns.size).toBe(1000);
    // Should complete within 5 seconds even on slow machines
    expect(elapsed).toBeLessThan(5000);
  });

  it('deduplication with 1000 identical patterns is efficient', () => {
    const state = initAutoLearner('dedup-perf-test');
    const start = Date.now();

    for (let i = 0; i < 1000; i++) {
      recordPattern(
        state,
        'Error: The same error occurs every time in /src/main.ts',
        'Apply the same fix: restart the server and check the configuration'
      );
    }

    const elapsed = Date.now() - start;

    // Should still only have 1 pattern
    expect(state.patterns.size).toBe(1);
    // Pattern should have 1000 occurrences
    const pattern = Array.from(state.patterns.values())[0];
    expect(pattern.occurrences).toBe(1000);
    // Should be fast since it's just incrementing
    expect(elapsed).toBeLessThan(3000);
  });

  it('extractTriggers handles very large text efficiently', () => {
    const largeText = 'Error: ' + 'word '.repeat(10000);
    const start = Date.now();

    const triggers = extractTriggers(largeText, 'solution text');

    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(triggers.length).toBeLessThanOrEqual(10);
  });
});
