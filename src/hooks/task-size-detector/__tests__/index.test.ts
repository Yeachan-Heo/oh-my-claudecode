import { describe, it, expect } from 'vitest';
import {
  classifyTaskSize,
  countWords,
  detectEscapeHatch,
  hasSmallTaskSignals,
  hasLargeTaskSignals,
  isHeavyMode,
  HEAVY_MODE_KEYWORDS,
  DEFAULT_THRESHOLDS,
  type TaskSize,
  type TaskSizeResult,
} from '../index.js';

describe('task-size-detector', () => {
  describe('countWords', () => {
    it('counts words correctly', () => {
      expect(countWords('hello world')).toBe(2);
    });

    it('handles leading/trailing whitespace', () => {
      expect(countWords('  hello world  ')).toBe(2);
    });

    it('handles multiple spaces between words', () => {
      expect(countWords('hello   world')).toBe(2);
    });

    it('handles empty string', () => {
      expect(countWords('')).toBe(0);
    });

    it('handles single word', () => {
      expect(countWords('hello')).toBe(1);
    });

    it('handles newlines and tabs', () => {
      expect(countWords('hello\nworld\ttab')).toBe(3);
    });
  });

  describe('detectEscapeHatch', () => {
    it('detects quick: prefix', () => {
      expect(detectEscapeHatch('quick: fix the typo')).toBe('quick:');
    });

    it('detects simple: prefix', () => {
      expect(detectEscapeHatch('simple: rename the variable')).toBe('simple:');
    });

    it('detects tiny: prefix', () => {
      expect(detectEscapeHatch('tiny: add a comment')).toBe('tiny:');
    });

    it('detects minor: prefix', () => {
      expect(detectEscapeHatch('minor: update README')).toBe('minor:');
    });

    it('detects small: prefix', () => {
      expect(detectEscapeHatch('small: fix lint warning')).toBe('small:');
    });

    it('detects just: prefix', () => {
      expect(detectEscapeHatch('just: update the version number')).toBe('just:');
    });

    it('detects only: prefix', () => {
      expect(detectEscapeHatch('only: add a missing semicolon')).toBe('only:');
    });

    it('is case-insensitive', () => {
      expect(detectEscapeHatch('Quick: fix this')).toBe('quick:');
      expect(detectEscapeHatch('SIMPLE: rename')).toBe('simple:');
    });

    it('returns null when no escape hatch', () => {
      expect(detectEscapeHatch('fix the authentication bug')).toBeNull();
    });

    it('returns null for partial prefix match', () => {
      expect(detectEscapeHatch('quickly fix the bug')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectEscapeHatch('')).toBeNull();
    });
  });

  describe('hasSmallTaskSignals', () => {
    it('detects typo signal', () => {
      expect(hasSmallTaskSignals('fix the typo in README')).toBe(true);
    });

    it('detects spelling signal', () => {
      expect(hasSmallTaskSignals('fix spelling error')).toBe(true);
    });

    it('detects rename signal', () => {
      expect(hasSmallTaskSignals('rename foo to bar')).toBe(true);
    });

    it('detects single file signal', () => {
      expect(hasSmallTaskSignals('change this in single file')).toBe(true);
    });

    it('detects "in this file" signal', () => {
      expect(hasSmallTaskSignals('update the config in this file')).toBe(true);
    });

    it('detects "this function" signal', () => {
      expect(hasSmallTaskSignals('fix this function to return null')).toBe(true);
    });

    it('detects minor fix signal', () => {
      expect(hasSmallTaskSignals('minor fix needed in the handler')).toBe(true);
    });

    it('detects quick fix signal', () => {
      expect(hasSmallTaskSignals('quick fix for the login bug')).toBe(true);
    });

    it('detects whitespace signal', () => {
      expect(hasSmallTaskSignals('remove extra whitespace')).toBe(true);
    });

    it('detects indentation signal', () => {
      expect(hasSmallTaskSignals('fix indentation in the block')).toBe(true);
    });

    it('detects add comment signal', () => {
      expect(hasSmallTaskSignals('add a comment to this block')).toBe(true);
    });

    it('detects bump version signal', () => {
      expect(hasSmallTaskSignals('bump version to 2.0.0')).toBe(true);
    });

    it('returns false for regular task', () => {
      expect(hasSmallTaskSignals('implement user authentication flow')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasSmallTaskSignals('')).toBe(false);
    });
  });

  describe('hasLargeTaskSignals', () => {
    it('detects architecture signal', () => {
      expect(hasLargeTaskSignals('redesign the architecture of the auth system')).toBe(true);
    });

    it('detects refactor signal', () => {
      expect(hasLargeTaskSignals('refactor the entire module')).toBe(true);
    });

    it('detects redesign signal', () => {
      expect(hasLargeTaskSignals('redesign the API layer')).toBe(true);
    });

    it('detects "entire codebase" signal', () => {
      expect(hasLargeTaskSignals('update imports across the entire codebase')).toBe(true);
    });

    it('detects "all files" signal', () => {
      expect(hasLargeTaskSignals('update all files to use ESM')).toBe(true);
    });

    it('detects "multiple files" signal', () => {
      expect(hasLargeTaskSignals('change imports across multiple files')).toBe(true);
    });

    it('detects migration signal', () => {
      expect(hasLargeTaskSignals('migrate the database schema')).toBe(true);
    });

    it('detects "from scratch" signal', () => {
      expect(hasLargeTaskSignals('rewrite the parser from scratch')).toBe(true);
    });

    it('detects "end-to-end" signal', () => {
      expect(hasLargeTaskSignals('implement end-to-end testing')).toBe(true);
    });

    it('detects overhaul signal', () => {
      expect(hasLargeTaskSignals('overhaul the permissions system')).toBe(true);
    });

    it('detects comprehensive signal', () => {
      expect(hasLargeTaskSignals('do a comprehensive review')).toBe(true);
    });

    it('returns false for small task', () => {
      expect(hasLargeTaskSignals('fix the typo')).toBe(false);
    });

    it('returns false for medium task', () => {
      expect(hasLargeTaskSignals('add error handling to the login handler')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasLargeTaskSignals('')).toBe(false);
    });
  });

  describe('classifyTaskSize', () => {
    describe('escape hatch detection', () => {
      it('classifies as small when quick: prefix present', () => {
        const result = classifyTaskSize('quick: refactor the entire auth system');
        expect(result.size).toBe('small');
        expect(result.hasEscapeHatch).toBe(true);
        expect(result.escapePrefixUsed).toBe('quick:');
      });

      it('classifies as small for simple: prefix even with large signals', () => {
        const result = classifyTaskSize('simple: redesign the entire architecture');
        expect(result.size).toBe('small');
        expect(result.hasEscapeHatch).toBe(true);
      });

      it('includes the escape prefix in result', () => {
        const result = classifyTaskSize('tiny: fix the return type');
        expect(result.escapePrefixUsed).toBe('tiny:');
      });
    });

    describe('small task classification', () => {
      it('classifies short prompt as small', () => {
        const result = classifyTaskSize('Fix the typo in the README.');
        expect(result.size).toBe('small');
      });

      it('classifies prompt with small signals as small', () => {
        const result = classifyTaskSize('Rename the getUserById function to fetchUserById in this file');
        expect(result.size).toBe('small');
      });

      it('classifies typo fix as small', () => {
        const result = classifyTaskSize('fix a typo in the login error message');
        expect(result.size).toBe('small');
      });

      it('classifies minor change as small', () => {
        const result = classifyTaskSize('minor fix: update the comment in the validator');
        expect(result.size).toBe('small');
      });

      it('includes word count in result', () => {
        const result = classifyTaskSize('fix typo');
        expect(result.wordCount).toBe(2);
      });

      it('hasEscapeHatch is false for organic small task', () => {
        const result = classifyTaskSize('fix the typo');
        expect(result.hasEscapeHatch).toBe(false);
      });
    });

    describe('large task classification', () => {
      it('classifies prompt with large signals as large', () => {
        const result = classifyTaskSize(
          'Refactor the authentication module to support OAuth2 and clean up the token management'
        );
        expect(result.size).toBe('large');
      });

      it('classifies very long prompt as large', () => {
        // Generate a 250-word prompt
        const longPrompt = Array(250).fill('word').join(' ');
        const result = classifyTaskSize(longPrompt);
        expect(result.size).toBe('large');
      });

      it('classifies "entire codebase" task as large', () => {
        const result = classifyTaskSize('Update all imports across the entire codebase to use path aliases');
        expect(result.size).toBe('large');
      });

      it('classifies migration as large even if short', () => {
        // "migrate the schema" has large signal and is > smallWordLimit threshold
        const text = 'migrate the database schema to the new format using the updated ORM models and fix related tests';
        const result = classifyTaskSize(text);
        expect(result.size).toBe('large');
      });
    });

    describe('medium task classification', () => {
      it('classifies medium-length prompt with no special signals as medium', () => {
        // Build a prompt between 50-200 words with no large/small signals
        const words = Array(80).fill('word').join(' ');
        const result = classifyTaskSize(`Add error handling to the login handler. ${words}`);
        expect(result.size).toBe('medium');
      });

      it('returns medium when between limits and no signals', () => {
        const text = Array(75).fill('update').join(' ');
        const result = classifyTaskSize(text);
        expect(result.size).toBe('medium');
      });
    });

    describe('custom thresholds', () => {
      it('uses custom smallWordLimit', () => {
        const result = classifyTaskSize('word '.repeat(30).trim(), {
          smallWordLimit: 100,
          largeWordLimit: 200,
        });
        expect(result.size).toBe('small');
      });

      it('uses custom largeWordLimit', () => {
        const result = classifyTaskSize('word '.repeat(60).trim(), {
          smallWordLimit: 10,
          largeWordLimit: 50,
        });
        expect(result.size).toBe('large');
      });
    });

    describe('reason field', () => {
      it('includes reason for escape hatch', () => {
        const result = classifyTaskSize('quick: fix this');
        expect(result.reason).toContain('quick:');
      });

      it('includes reason for large signals', () => {
        const result = classifyTaskSize(
          'Refactor the entire architecture of the application including all modules and cross-cutting concerns to support microservices'
        );
        expect(result.reason.toLowerCase()).toContain('large');
      });

      it('includes word count in reason for word-count-based decisions', () => {
        const shortText = 'fix the bug';
        const result = classifyTaskSize(shortText);
        expect(result.reason).toContain(String(result.wordCount));
      });
    });
  });

  describe('isHeavyMode', () => {
    it('returns true for ralph', () => {
      expect(isHeavyMode('ralph')).toBe(true);
    });

    it('returns true for autopilot', () => {
      expect(isHeavyMode('autopilot')).toBe(true);
    });

    it('returns true for team', () => {
      expect(isHeavyMode('team')).toBe(true);
    });

    it('returns true for ultrawork', () => {
      expect(isHeavyMode('ultrawork')).toBe(true);
    });

    it('returns true for ultrapilot', () => {
      expect(isHeavyMode('ultrapilot')).toBe(true);
    });

    it('returns true for swarm', () => {
      expect(isHeavyMode('swarm')).toBe(true);
    });

    it('returns true for pipeline', () => {
      expect(isHeavyMode('pipeline')).toBe(true);
    });

    it('returns true for ralplan', () => {
      expect(isHeavyMode('ralplan')).toBe(true);
    });

    it('returns true for ccg', () => {
      expect(isHeavyMode('ccg')).toBe(true);
    });

    it('returns false for cancel', () => {
      expect(isHeavyMode('cancel')).toBe(false);
    });

    it('returns false for plan', () => {
      expect(isHeavyMode('plan')).toBe(false);
    });

    it('returns false for tdd', () => {
      expect(isHeavyMode('tdd')).toBe(false);
    });

    it('returns false for ultrathink', () => {
      expect(isHeavyMode('ultrathink')).toBe(false);
    });

    it('returns false for deepsearch', () => {
      expect(isHeavyMode('deepsearch')).toBe(false);
    });

    it('returns false for analyze', () => {
      expect(isHeavyMode('analyze')).toBe(false);
    });

    it('returns false for codex', () => {
      expect(isHeavyMode('codex')).toBe(false);
    });

    it('returns false for gemini', () => {
      expect(isHeavyMode('gemini')).toBe(false);
    });

    it('returns false for unknown keyword', () => {
      expect(isHeavyMode('unknown-mode')).toBe(false);
    });
  });

  describe('HEAVY_MODE_KEYWORDS set', () => {
    it('contains expected heavy modes', () => {
      const expected = ['ralph', 'autopilot', 'team', 'ultrawork', 'ultrapilot', 'swarm', 'pipeline', 'ralplan', 'ccg'];
      for (const mode of expected) {
        expect(HEAVY_MODE_KEYWORDS.has(mode)).toBe(true);
      }
    });

    it('does not contain lightweight modes', () => {
      const lightweight = ['cancel', 'plan', 'tdd', 'ultrathink', 'deepsearch', 'analyze', 'codex', 'gemini'];
      for (const mode of lightweight) {
        expect(HEAVY_MODE_KEYWORDS.has(mode)).toBe(false);
      }
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('has smallWordLimit of 50', () => {
      expect(DEFAULT_THRESHOLDS.smallWordLimit).toBe(50);
    });

    it('has largeWordLimit of 200', () => {
      expect(DEFAULT_THRESHOLDS.largeWordLimit).toBe(200);
    });
  });
});
