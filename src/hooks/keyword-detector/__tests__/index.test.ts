import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  removeCodeBlocks,
  sanitizeForKeywordDetection,
  extractPromptText,
  detectKeywordsWithType,
  hasKeyword,
  getPrimaryKeyword,
  getAllKeywords,
  getAllKeywordsWithSizeCheck,
  isUnderspecifiedForExecution,
  applyRalplanGate,
  NON_LATIN_SCRIPT_PATTERN,
  type KeywordType,
  type DetectedKeyword,
} from '../index.js';

// Mock isTeamEnabled
vi.mock('../../../features/auto-update.js', () => ({
  isTeamEnabled: vi.fn(() => true),
}));

import { isTeamEnabled } from '../../../features/auto-update.js';
const mockedIsTeamEnabled = vi.mocked(isTeamEnabled);

describe('keyword-detector', () => {
  describe('removeCodeBlocks', () => {
    it('should remove fenced code blocks with triple backticks', () => {
      const text = 'Before ```code here``` after';
      expect(removeCodeBlocks(text)).toBe('Before  after');
    });

    it('should remove fenced code blocks with tildes', () => {
      const text = 'Before ~~~code here~~~ after';
      expect(removeCodeBlocks(text)).toBe('Before  after');
    });

    it('should remove multiline fenced code blocks', () => {
      const text = `Hello
\`\`\`javascript
const x = 1;
const y = 2;
\`\`\`
World`;
      expect(removeCodeBlocks(text)).toBe(`Hello

World`);
    });

    it('should remove inline code with single backticks', () => {
      const text = 'Use `autopilot` command here';
      expect(removeCodeBlocks(text)).toBe('Use  command here');
    });

    it('should handle nested backticks in fenced blocks', () => {
      // The regex matches ```...``` greedily, so ```const x = `test````
      // matches from first ``` to the triple backtick at the end
      const text = 'Before ```const x = `test` ``` after';
      expect(removeCodeBlocks(text)).toBe('Before  after');
    });

    it('should handle multiple code blocks', () => {
      const text = '`a` middle `b` end';
      expect(removeCodeBlocks(text)).toBe(' middle  end');
    });

    it('should handle empty input', () => {
      expect(removeCodeBlocks('')).toBe('');
    });

    it('should return text unchanged when no code blocks', () => {
      const text = 'Regular text without code';
      expect(removeCodeBlocks(text)).toBe('Regular text without code');
    });

    it('should handle code blocks with language specifier', () => {
      const text = '```typescript\nconst x = 1;\n``` done';
      expect(removeCodeBlocks(text)).toBe(' done');
    });
  });

  describe('sanitizeForKeywordDetection', () => {
    it('should strip XML tag blocks', () => {
      const result = sanitizeForKeywordDetection('<system-reminder>ralph</system-reminder>');
      expect(result).not.toContain('ralph');
    });

    it('should strip self-closing XML tags', () => {
      const result = sanitizeForKeywordDetection('text <br /> more');
      expect(result).not.toContain('<br');
    });

    it('should strip URLs', () => {
      const result = sanitizeForKeywordDetection('see https://example.com/codex/path');
      expect(result).not.toContain('codex');
    });

    it('should strip file paths', () => {
      const result = sanitizeForKeywordDetection('open src/mcp/codex-core.ts');
      expect(result).not.toContain('codex');
    });

    it('should strip markdown code blocks', () => {
      const result = sanitizeForKeywordDetection('```\nask codex\n```');
      expect(result).not.toContain('codex');
    });

    it('should strip inline code', () => {
      const result = sanitizeForKeywordDetection('use `ask codex` command');
      expect(result).not.toContain('codex');
    });

    it('should preserve normal text', () => {
      const result = sanitizeForKeywordDetection('ask codex to review');
      expect(result).toContain('ask codex');
    });

    it('should not over-strip when XML tag names differ', () => {
      // Mismatched tags should not strip content between them
      const result = sanitizeForKeywordDetection('<open>ralph</close> hello');
      expect(result).toContain('ralph');
    });

    it('should strip matching XML tags correctly', () => {
      const result = sanitizeForKeywordDetection('<div>ralph</div> hello');
      expect(result).not.toContain('ralph');
      expect(result).toContain('hello');
    });

    it('should strip nested matching XML tags', () => {
      const result = sanitizeForKeywordDetection('<outer>some <inner>text</inner> ralph</outer> visible');
      expect(result).not.toContain('ralph');
      expect(result).toContain('visible');
    });

    it('should strip absolute file paths starting with /', () => {
      const result = sanitizeForKeywordDetection('open /usr/local/bin/codex');
      expect(result).not.toContain('codex');
    });

    it('should strip relative file paths starting with ./', () => {
      const result = sanitizeForKeywordDetection('edit ./src/codex.ts');
      expect(result).not.toContain('codex');
    });

    it('should strip multi-segment file paths', () => {
      const result = sanitizeForKeywordDetection('open src/mcp/codex-core.ts');
      expect(result).not.toContain('codex');
    });

    it('should NOT strip standalone words that look like single segments', () => {
      // "ask codex" should not be stripped since "codex" is not a path
      const result = sanitizeForKeywordDetection('ask codex to review');
      expect(result).toContain('ask codex');
    });

    it('should NOT strip slash-less words with dots', () => {
      // "file.txt" alone (no path separator) should be kept
      const result = sanitizeForKeywordDetection('rename codex.config');
      expect(result).toContain('codex');
    });
  });

  describe('extractPromptText', () => {
    it('should extract text from text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ];
      expect(extractPromptText(parts)).toBe('Hello World');
    });

    it('should ignore non-text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'image', url: 'http://example.com' },
        { type: 'text', text: 'World' },
      ];
      expect(extractPromptText(parts)).toBe('Hello World');
    });

    it('should handle empty parts array', () => {
      expect(extractPromptText([])).toBe('');
    });

    it('should handle parts with no text', () => {
      const parts = [
        { type: 'text' },
        { type: 'text', text: 'Valid' },
      ];
      expect(extractPromptText(parts)).toBe('Valid');
    });

    it('should handle undefined text gracefully', () => {
      const parts = [
        { type: 'text', text: undefined },
        { type: 'text', text: 'Hello' },
      ];
      expect(extractPromptText(parts)).toBe('Hello');
    });

    it('should handle all non-text parts', () => {
      const parts = [
        { type: 'image' },
        { type: 'tool_use' },
      ];
      expect(extractPromptText(parts)).toBe('');
    });
  });

  describe('detectKeywordsWithType', () => {
    describe('ralph keyword', () => {
      it('should detect ralph keyword', () => {
        const result = detectKeywordsWithType('Please ralph this task');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeDefined();
        expect(ralphMatch?.keyword).toBe('ralph');
      });

      it('should NOT detect "don\'t stop" phrase', () => {
        const result = detectKeywordsWithType("Don't stop until done");
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeUndefined();
      });

      it('should NOT detect "must complete" phrase', () => {
        const result = detectKeywordsWithType('You must complete this task');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeUndefined();
      });

      it('should NOT detect "until done" phrase', () => {
        const result = detectKeywordsWithType('Keep going until done');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeUndefined();
      });
    });

    describe('autopilot keyword', () => {
      it('should detect autopilot keyword', () => {
        const result = detectKeywordsWithType('Run in autopilot mode');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect "auto pilot" with space', () => {
        const result = detectKeywordsWithType('Enable auto pilot');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect "auto-pilot" with hyphen', () => {
        const result = detectKeywordsWithType('Enable auto-pilot mode');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect "full auto" keyword', () => {
        const result = detectKeywordsWithType('Go full auto on this');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect "fullsend" keyword', () => {
        const result = detectKeywordsWithType('fullsend this implementation');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should NOT detect "build me" phrase', () => {
        const result = detectKeywordsWithType('build me a web app');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeUndefined();
      });

      it('should NOT detect "autonomous" keyword', () => {
        const result = detectKeywordsWithType('Run in autonomous mode');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeUndefined();
      });
    });

    describe('ultrawork keyword', () => {
      it('should detect ultrawork keyword', () => {
        const result = detectKeywordsWithType('Do ultrawork on this');
        const ultraworkMatch = result.find((r) => r.type === 'ultrawork');
        expect(ultraworkMatch).toBeDefined();
      });

      it('should detect ulw abbreviation', () => {
        const result = detectKeywordsWithType('ulw this code');
        const ultraworkMatch = result.find((r) => r.type === 'ultrawork');
        expect(ultraworkMatch).toBeDefined();
      });

      it('should NOT detect uw abbreviation', () => {
        const result = detectKeywordsWithType('uw this code');
        const ultraworkMatch = result.find((r) => r.type === 'ultrawork');
        expect(ultraworkMatch).toBeUndefined();
      });
    });

    describe('pipeline keyword', () => {
      it('should detect agent pipeline phrase', () => {
        const result = detectKeywordsWithType('agent pipeline build the API');
        const pipelineMatch = result.find((r) => r.type === 'pipeline');
        expect(pipelineMatch).toBeDefined();
      });

      it('should detect chain agents phrase', () => {
        const result = detectKeywordsWithType('chain agents to build');
        const pipelineMatch = result.find((r) => r.type === 'pipeline');
        expect(pipelineMatch).toBeDefined();
      });

      it('should NOT detect bare pipeline keyword', () => {
        const result = detectKeywordsWithType('pipeline fix this');
        const pipelineMatch = result.find((r) => r.type === 'pipeline');
        expect(pipelineMatch).toBeUndefined();
      });

      it('should NOT detect CI/CD pipeline', () => {
        const result = detectKeywordsWithType('the CI pipeline is broken');
        const pipelineMatch = result.find((r) => r.type === 'pipeline');
        expect(pipelineMatch).toBeUndefined();
      });
    });

    describe('tdd keyword', () => {
      it('should detect tdd keyword', () => {
        const result = detectKeywordsWithType('tdd this feature');
        const tddMatch = result.find((r) => r.type === 'tdd');
        expect(tddMatch).toBeDefined();
      });

      it('should detect test first phrase', () => {
        const result = detectKeywordsWithType('test first approach');
        const tddMatch = result.find((r) => r.type === 'tdd');
        expect(tddMatch).toBeDefined();
      });

      it('should NOT detect red green phrase', () => {
        const result = detectKeywordsWithType('red green refactor cycle');
        const tddMatch = result.find((r) => r.type === 'tdd');
        expect(tddMatch).toBeUndefined();
      });
    });

    describe('ultrathink keyword', () => {
      it('should detect ultrathink keyword', () => {
        const result = detectKeywordsWithType('ultrathink about this problem');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeDefined();
      });

      it('should NOT detect "think hard" phrase', () => {
        const result = detectKeywordsWithType('think hard about this problem');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeUndefined();
      });

      it('should NOT detect "think deeply" phrase', () => {
        const result = detectKeywordsWithType('think deeply about this problem');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeUndefined();
      });
    });

    describe('deepsearch keyword', () => {
      it('should detect deepsearch keyword', () => {
        const result = detectKeywordsWithType('deepsearch for files');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeDefined();
      });

      it('should detect search the codebase', () => {
        const result = detectKeywordsWithType('search the codebase');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeDefined();
      });

      it('should detect find in codebase', () => {
        const result = detectKeywordsWithType('find in codebase');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeDefined();
      });

      it('should detect find in the codebase', () => {
        const result = detectKeywordsWithType('find in the codebase');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeDefined();
      });

      it('should NOT detect generic find', () => {
        const result = detectKeywordsWithType('find the bug');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeUndefined();
      });

      it('should NOT detect search code pattern', () => {
        const result = detectKeywordsWithType('search code for errors');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeUndefined();
      });

      it('should NOT detect find in all files', () => {
        const result = detectKeywordsWithType('find in all files');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeUndefined();
      });

      it('should NOT detect search project', () => {
        const result = detectKeywordsWithType('search the project');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeUndefined();
      });

      it('should NOT detect search files', () => {
        const result = detectKeywordsWithType('search files for errors');
        const searchMatch = result.find((r) => r.type === 'deepsearch');
        expect(searchMatch).toBeUndefined();
      });
    });

    describe('analyze keyword', () => {
      it('should detect deep analyze keyword', () => {
        const result = detectKeywordsWithType('deep analyze this code');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect deep-analyze with hyphen', () => {
        const result = detectKeywordsWithType('deep-analyze this code');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect deepanalyze without space', () => {
        const result = detectKeywordsWithType('deepanalyze this code');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should NOT detect investigate with context', () => {
        const result = detectKeywordsWithType('investigate the issue');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect investigate this', () => {
        const result = detectKeywordsWithType('investigate this bug');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect investigate why', () => {
        const result = detectKeywordsWithType('investigate why this fails');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect debug the', () => {
        const result = detectKeywordsWithType('debug the function');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect debug this', () => {
        const result = detectKeywordsWithType('debug this issue');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect debug why', () => {
        const result = detectKeywordsWithType('debug why this breaks');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });

      it('should NOT detect generic analyze', () => {
        const result = detectKeywordsWithType('analyze without context');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeUndefined();
      });
    });


    describe('case insensitivity', () => {
      it('should detect RALPH in uppercase', () => {
        const result = detectKeywordsWithType('RALPH this task');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeDefined();
      });

      it('should detect AUTOPILOT in uppercase', () => {
        const result = detectKeywordsWithType('AUTOPILOT mode');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect mixed case keywords', () => {
        const result = detectKeywordsWithType('UltraThink about this');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeDefined();
      });
    });

    describe('code block exclusion', () => {
      it('should not detect keyword inside fenced code block', () => {
        const text = '```\nautopilot\n```';
        const result = detectKeywordsWithType(text);
        expect(result.length).toBe(0);
      });

      it('should not detect keyword inside inline code', () => {
        const text = 'Use `autopilot` command';
        const result = detectKeywordsWithType(text);
        expect(result.length).toBe(0);
      });

      it('should detect keyword outside code block but not inside', () => {
        const text = 'autopilot ```autopilot``` end';
        const result = detectKeywordsWithType(text);
        const autopilotMatches = result.filter((r) => r.type === 'autopilot');
        expect(autopilotMatches.length).toBeGreaterThan(0);
      });

      it('should not detect keyword inside XML tags', () => {
        const text = '<system-reminder>ralph</system-reminder> hello';
        const result = detectKeywordsWithType(text);
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeUndefined();
      });
    });

    describe('codex keyword', () => {
      it('should detect "ask codex"', () => {
        const result = detectKeywordsWithType('ask codex to review');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeDefined();
      });

      it('should detect "use gpt"', () => {
        const result = detectKeywordsWithType('use gpt for review');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeDefined();
      });

      it('should detect "delegate to codex"', () => {
        const result = detectKeywordsWithType('delegate to codex');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeDefined();
      });

      it('should detect "delegate to gpt"', () => {
        const result = detectKeywordsWithType('delegate to gpt');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeDefined();
      });

      it('should NOT detect bare codex keyword', () => {
        const result = detectKeywordsWithType('codex review this');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });

      it('should NOT detect bare gpt keyword', () => {
        const result = detectKeywordsWithType('gpt is great');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });

      it('should NOT detect gpt model names', () => {
        const result = detectKeywordsWithType('gpt-5.3 model');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });

      it('should NOT detect chatgpt', () => {
        const result = detectKeywordsWithType('chatgpt helped');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });
    });

    describe('ccg keyword', () => {
      it('should detect "ccg" keyword', () => {
        const result = detectKeywordsWithType('ccg this feature');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeDefined();
        expect(ccgMatch?.keyword).toMatch(/ccg/i);
      });

      it('should detect "claude-codex-gemini" keyword', () => {
        const result = detectKeywordsWithType('use claude-codex-gemini to build this');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeDefined();
      });

      it('should detect CCG in uppercase', () => {
        const result = detectKeywordsWithType('CCG add user profile page');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeDefined();
      });

      it('should NOT detect ccg inside code block', () => {
        const result = detectKeywordsWithType('```\nccg mode\n```');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeUndefined();
      });

      it('should NOT detect ccg inside inline code', () => {
        const result = detectKeywordsWithType('use `ccg` command');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeUndefined();
      });

      it('should detect ccg with other text around it', () => {
        const result = detectKeywordsWithType('please ccg this full-stack feature');
        const ccgMatch = result.find((r) => r.type === 'ccg');
        expect(ccgMatch).toBeDefined();
      });
    });

    describe('gemini keyword', () => {
      it('should detect "ask gemini"', () => {
        const result = detectKeywordsWithType('ask gemini to design');
        const geminiMatch = result.find((r) => r.type === 'gemini');
        expect(geminiMatch).toBeDefined();
      });

      it('should detect "use gemini"', () => {
        const result = detectKeywordsWithType('use gemini for UI');
        const geminiMatch = result.find((r) => r.type === 'gemini');
        expect(geminiMatch).toBeDefined();
      });

      it('should detect "delegate to gemini"', () => {
        const result = detectKeywordsWithType('delegate to gemini');
        const geminiMatch = result.find((r) => r.type === 'gemini');
        expect(geminiMatch).toBeDefined();
      });

      it('should NOT detect bare gemini keyword', () => {
        const result = detectKeywordsWithType('gemini constellation');
        const geminiMatch = result.find((r) => r.type === 'gemini');
        expect(geminiMatch).toBeUndefined();
      });

      it('should NOT detect gemini in non-intent context', () => {
        const result = detectKeywordsWithType('the Gemini project');
        const geminiMatch = result.find((r) => r.type === 'gemini');
        expect(geminiMatch).toBeUndefined();
      });
    });

    describe('sanitization false-positive prevention', () => {
      it('should NOT detect codex in URL', () => {
        const result = detectKeywordsWithType('see https://example.com/gpt');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });

      it('should NOT detect codex in file path', () => {
        const result = detectKeywordsWithType('open docs/gpt/README.md');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });

      it('should NOT detect codex in inline code', () => {
        const result = detectKeywordsWithType('`ask codex`');
        const codexMatch = result.find((r) => r.type === 'codex');
        expect(codexMatch).toBeUndefined();
      });
    });

    describe('edge cases', () => {
      it('should handle empty input', () => {
        const result = detectKeywordsWithType('');
        expect(result.length).toBe(0);
      });

      it('should handle whitespace only input', () => {
        const result = detectKeywordsWithType('   \n\t   ');
        expect(result.length).toBe(0);
      });

      it('should handle special characters', () => {
        const result = detectKeywordsWithType('!@#$%^&*()');
        expect(result.length).toBe(0);
      });

      it('should return position of detected keywords', () => {
        const text = 'Please autopilot this';
        const result = detectKeywordsWithType(text);
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch?.position).toBeGreaterThanOrEqual(0);
      });

      it('should detect multiple different keyword types', () => {
        const text = 'autopilot and deep analyze the bug';
        const result = detectKeywordsWithType(text);
        const types = result.map((r) => r.type);
        expect(types).toContain('autopilot');
        expect(types).toContain('analyze');
      });
    });
  });

  describe('hasKeyword', () => {
    it('should return true when keyword exists', () => {
      expect(hasKeyword('autopilot this')).toBe(true);
    });

    it('should return true for ralph keyword', () => {
      expect(hasKeyword('ralph the task')).toBe(true);
    });

    it('should return false when no keyword exists', () => {
      expect(hasKeyword('regular text here')).toBe(false);
    });

    it('should return false for empty input', () => {
      expect(hasKeyword('')).toBe(false);
    });

    it('should return false when keyword is inside code block', () => {
      expect(hasKeyword('```autopilot```')).toBe(false);
    });

    it('should return true when keyword is outside code block', () => {
      expect(hasKeyword('autopilot ```other code```')).toBe(true);
    });
  });

  describe('getPrimaryKeyword', () => {
    describe('priority order', () => {
      it('should return ralph over autopilot', () => {
        const result = getPrimaryKeyword('ralph and autopilot');
        expect(result?.type).toBe('ralph');
      });

      it('should return autopilot over ultrawork', () => {
        const result = getPrimaryKeyword('autopilot and ultrawork');
        expect(result?.type).toBe('autopilot');
      });

      it('should return ultrawork over ultrathink', () => {
        const result = getPrimaryKeyword('ultrawork and ultrathink');
        expect(result?.type).toBe('ultrawork');
      });

      it('should return ultrathink over deepsearch', () => {
        const result = getPrimaryKeyword('ultrathink and search the codebase');
        expect(result?.type).toBe('ultrathink');
      });

      it('should return deepsearch over analyze', () => {
        const result = getPrimaryKeyword('find in codebase and debug the issue');
        expect(result?.type).toBe('deepsearch');
      });

      it('should return analyze when it is the only keyword', () => {
        const result = getPrimaryKeyword('deep analyze the issue');
        expect(result?.type).toBe('analyze');
      });
    });

    describe('multiple keyword conflict resolution', () => {
      it('should return cancel over everything', () => {
        const result = getPrimaryKeyword('cancelomc ralph ultrawork');
        expect(result?.type).toBe('cancel');
      });

      it('should return ralph over ultrawork', () => {
        const result = getPrimaryKeyword('ralph ulw fix errors');
        expect(result?.type).toBe('ralph');
      });

      it('should detect all keywords even when multiple present', () => {
        const result = detectKeywordsWithType('ulw ralph fix errors');
        const types = result.map(r => r.type);
        expect(types).toContain('ultrawork');
        expect(types).toContain('ralph');
      });
    });

    it('should return null when no keyword found', () => {
      const result = getPrimaryKeyword('regular text');
      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      const result = getPrimaryKeyword('');
      expect(result).toBeNull();
    });

    it('should return null when keyword is in code block', () => {
      const result = getPrimaryKeyword('```autopilot```');
      expect(result).toBeNull();
    });

    it('should return keyword with correct type and position', () => {
      const result = getPrimaryKeyword('autopilot this task');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('autopilot');
      expect(result?.keyword).toBeDefined();
      expect(result?.position).toBeGreaterThanOrEqual(0);
    });

    it('should handle complex text with multiple keywords', () => {
      const text = 'Please ralph this and then autopilot the rest, think about it and analyze';
      const result = getPrimaryKeyword(text);
      // ralph has highest priority
      expect(result?.type).toBe('ralph');
    });
  });

  describe('getAllKeywords', () => {
    it('should return single keyword in array', () => {
      expect(getAllKeywords('autopilot this')).toEqual(['autopilot']);
    });

    it('should return multiple non-conflicting keywords in priority order', () => {
      expect(getAllKeywords('ulw ralph fix errors')).toEqual(['ralph', 'ultrawork']);
    });

    it('should return cancel exclusively when present', () => {
      expect(getAllKeywords('cancelomc ralph ultrawork')).toEqual(['cancel']);
    });

    it('should return team and ultrapilot when legacy ultrapilot trigger is present', () => {
      const result = getAllKeywords('autopilot ultrapilot build');
      expect(result).toContain('ultrapilot');
      expect(result).toContain('team');
      // team beats autopilot, but original ultrapilot is preserved
      expect(result).not.toContain('autopilot');
    });

    it('should return team and swarm for legacy swarm trigger', () => {
      const result = getAllKeywords('swarm 5 agents build this');
      expect(result).toContain('swarm');
      expect(result).toContain('team');
    });

    it('should return ralph with ultrawork (not mutually exclusive)', () => {
      const result = getAllKeywords('ralph ultrawork fix');
      expect(result).toContain('ralph');
      expect(result).toContain('ultrawork');
    });

    it('should return ralph with codex', () => {
      const result = getAllKeywords('ralph ask gpt to review');
      expect(result).toContain('ralph');
      expect(result).toContain('codex');
    });

    it('should return both codex and gemini when both present', () => {
      const result = getAllKeywords('ask codex and ask gemini');
      expect(result).toContain('codex');
      expect(result).toContain('gemini');
    });

    it('should return ccg when ccg keyword present', () => {
      const result = getAllKeywords('ccg add a user profile feature');
      expect(result).toContain('ccg');
    });

    it('should return ccg with higher priority than codex/gemini', () => {
      const result = getAllKeywords('ccg ask codex to review');
      const ccgIdx = result.indexOf('ccg');
      const codexIdx = result.indexOf('codex');
      expect(ccgIdx).toBeGreaterThanOrEqual(0);
      expect(codexIdx).toBeGreaterThanOrEqual(0);
      expect(ccgIdx).toBeLessThan(codexIdx);
    });

    it('should return ralph before ccg in priority order', () => {
      const result = getAllKeywords('ralph ccg build the app');
      const ralphIdx = result.indexOf('ralph');
      const ccgIdx = result.indexOf('ccg');
      expect(ralphIdx).toBeGreaterThanOrEqual(0);
      expect(ccgIdx).toBeGreaterThanOrEqual(0);
      expect(ralphIdx).toBeLessThan(ccgIdx);
    });

    it('should not return ccg when cancel is present', () => {
      const result = getAllKeywords('cancelomc ccg build');
      expect(result).toEqual(['cancel']);
      expect(result).not.toContain('ccg');
    });

    it('should return ralph over codex in priority', () => {
      const primary = getPrimaryKeyword('ralph ask codex');
      expect(primary?.type).toBe('ralph');
    });

    it('should return cancel over codex/gemini', () => {
      expect(getAllKeywords('cancelomc ask codex')).toEqual(['cancel']);
    });

    it('should return empty array for no keywords', () => {
      expect(getAllKeywords('regular text')).toEqual([]);
    });

    it('should handle code block exclusion', () => {
      expect(getAllKeywords('```autopilot```')).toEqual([]);
    });

    it('should handle multiple combinable keywords', () => {
      const result = getAllKeywords('ralph tdd fix');
      expect(result).toContain('ralph');
      expect(result).toContain('tdd');
    });

    // Team + Ralph composition tests
    it('should return both ralph and team when both present (linked mode)', () => {
      const result = getAllKeywords('team ralph build the API');
      expect(result).toContain('ralph');
      expect(result).toContain('team');
    });

    it('should return ralph before team in priority order', () => {
      const result = getAllKeywords('team ralph build the API');
      const ralphIdx = result.indexOf('ralph');
      const teamIdx = result.indexOf('team');
      expect(ralphIdx).toBeLessThan(teamIdx);
    });

    it('should return ralph as primary when team ralph is used', () => {
      const primary = getPrimaryKeyword('team ralph build the API');
      expect(primary?.type).toBe('ralph');
    });

    it('should return team and ralph with other keywords', () => {
      const result = getAllKeywords('team ralph ask codex to review');
      expect(result).toContain('ralph');
      expect(result).toContain('team');
      expect(result).toContain('codex');
    });

    it('should return team over autopilot even with ralph', () => {
      const result = getAllKeywords('ralph team autopilot build');
      expect(result).toContain('ralph');
      expect(result).toContain('team');
      expect(result).not.toContain('autopilot');
    });

    // Team keyword false positive prevention (intent-gated regex)
    it('should not detect team in "my team uses X"', () => {
      const result = getAllKeywords('my team uses React for frontend');
      expect(result).not.toContain('team');
    });

    it('should not detect team in "the team needs help"', () => {
      const result = getAllKeywords('the team needs help with deployment');
      expect(result).not.toContain('team');
    });

    it('should not detect team in "our team decided"', () => {
      const result = getAllKeywords('our team decided to use TypeScript');
      expect(result).not.toContain('team');
    });

    it('should not detect team in "a team of engineers"', () => {
      const result = getAllKeywords('a team of engineers built this');
      expect(result).not.toContain('team');
    });

    it('should detect team via coordinated team phrase', () => {
      const result = getAllKeywords('coordinated team build the API');
      expect(result).toContain('team');
    });

    it('should detect team via ultrapilot legacy keyword and preserve ultrapilot', () => {
      const result = getAllKeywords('ultrapilot build all components');
      expect(result).toContain('team');
      expect(result).toContain('ultrapilot');
    });

    it('should detect team via swarm N agents pattern and preserve swarm', () => {
      const result = getAllKeywords('swarm 5 agents fix all errors');
      expect(result).toContain('team');
      expect(result).toContain('swarm');
    });

    // Mixed keyword precedence tests
    it('should handle team + ralph combination', () => {
      const result = getAllKeywords('team ralph build the app');
      expect(result).toContain('ralph');
      expect(result).toContain('team');
    });

    it('should not detect cancel alongside team', () => {
      const result = getAllKeywords('cancelomc team');
      expect(result).toEqual(['cancel']);
      expect(result).not.toContain('team');
    });

    // Dedup regression test
    it('should deduplicate repeated keyword triggers', () => {
      const result = getAllKeywords('autopilot autopilot fix errors');
      const autopilotCount = result.filter(k => k === 'autopilot').length;
      expect(autopilotCount).toBe(1);
    });

    describe('when team is disabled via config', () => {
      beforeEach(() => {
        mockedIsTeamEnabled.mockReturnValue(false);
      });

      afterEach(() => {
        mockedIsTeamEnabled.mockReturnValue(true);
      });

      it('should NOT detect team keyword when disabled', () => {
        const result = getAllKeywords('team build the API');
        expect(result).not.toContain('team');
      });

      it('should NOT detect coordinated team when disabled', () => {
        const result = getAllKeywords('coordinated team build');
        expect(result).not.toContain('team');
      });

      it('should NOT detect ultrapilot or team when disabled', () => {
        const result = getAllKeywords('ultrapilot build all');
        expect(result).not.toContain('team');
        expect(result).not.toContain('ultrapilot');
      });

      it('should NOT detect swarm or team when disabled', () => {
        const result = getAllKeywords('swarm 5 agents fix errors');
        expect(result).not.toContain('team');
        expect(result).not.toContain('swarm');
      });

      it('should still detect other keywords when team disabled', () => {
        const result = getAllKeywords('team ralph build the API');
        expect(result).toContain('ralph');
        expect(result).not.toContain('team');
      });

      it('should not suppress autopilot when team is disabled', () => {
        const result = getAllKeywords('team autopilot build');
        expect(result).toContain('autopilot');
        expect(result).not.toContain('team');
      });
    });
  });

  describe('isUnderspecifiedForExecution (issue #997)', () => {
    it('should flag vague prompt with just mode keyword', () => {
      expect(isUnderspecifiedForExecution('ralph fix this')).toBe(true);
    });

    it('should flag prompt with no file or function references', () => {
      expect(isUnderspecifiedForExecution('ralph improve the performance')).toBe(true);
    });

    it('should flag short vague prompt', () => {
      expect(isUnderspecifiedForExecution('autopilot build the app')).toBe(true);
    });

    it('should flag empty prompt', () => {
      expect(isUnderspecifiedForExecution('')).toBe(true);
    });

    it('should pass prompt with specific file reference', () => {
      expect(isUnderspecifiedForExecution('ralph fix the bug in src/hooks/bridge.ts')).toBe(false);
    });

    it('should pass prompt with function reference', () => {
      expect(isUnderspecifiedForExecution('ralph fix function processKeywordDetector')).toBe(false);
    });

    it('should pass prompt with issue reference', () => {
      expect(isUnderspecifiedForExecution('ralph implement issue #42')).toBe(false);
    });

    it('should pass prompt with numbered steps', () => {
      expect(isUnderspecifiedForExecution('ralph do:\n1. Add validation\n2. Add tests\n3. Update docs')).toBe(false);
    });

    it('should pass prompt with code block', () => {
      const prompt = 'ralph add this function:\n```typescript\nfunction hello() { return "world"; }\n```';
      expect(isUnderspecifiedForExecution(prompt)).toBe(false);
    });

    it('should pass prompt with force: escape hatch', () => {
      expect(isUnderspecifiedForExecution('force: ralph fix this')).toBe(false);
    });

    it('should pass prompt with ! escape hatch', () => {
      expect(isUnderspecifiedForExecution('! ralph improve it')).toBe(false);
    });

    it('should pass prompt with path reference', () => {
      expect(isUnderspecifiedForExecution('ralph add logging to src/api/server.ts')).toBe(false);
    });

    it('should pass prompt with PR reference', () => {
      expect(isUnderspecifiedForExecution('ralph fix PR #123')).toBe(false);
    });

    it('should pass prompt with directory path', () => {
      expect(isUnderspecifiedForExecution('ralph refactor the hooks in src/hooks')).toBe(false);
    });

    it('should pass long detailed prompt without file refs', () => {
      expect(isUnderspecifiedForExecution(
        'ralph add a new API endpoint for user registration that accepts email and password, validates the input, hashes the password with bcrypt, stores in the users table, and returns a JWT token'
      )).toBe(false);
    });

    it('should pass prompt with acceptance criteria', () => {
      expect(isUnderspecifiedForExecution('ralph add login - acceptance criteria: user can log in with email')).toBe(false);
    });

    it('should pass prompt with error reference', () => {
      expect(isUnderspecifiedForExecution('ralph fix TypeError in the auth module')).toBe(false);
    });

    it('should pass prompt with bullet list', () => {
      expect(isUnderspecifiedForExecution('ralph implement:\n- Add user model\n- Add API routes')).toBe(false);
    });

    // False-positive prevention: concrete signals auto-pass
    describe('false-positive prevention', () => {
      it('should pass with camelCase symbol name', () => {
        expect(isUnderspecifiedForExecution('ralph fix processKeywordDetector')).toBe(false);
      });

      it('should pass with PascalCase class name', () => {
        expect(isUnderspecifiedForExecution('ralph update KeywordDetector')).toBe(false);
      });

      it('should pass with snake_case identifier', () => {
        expect(isUnderspecifiedForExecution('team fix user_model')).toBe(false);
      });

      it('should pass with bare issue number #123', () => {
        expect(isUnderspecifiedForExecution('ralph implement #42')).toBe(false);
      });

      it('should pass with test runner command', () => {
        expect(isUnderspecifiedForExecution('ralph npm test && fix failures')).toBe(false);
      });

      it('should pass with vitest target', () => {
        expect(isUnderspecifiedForExecution('ralph npx vitest run and fix')).toBe(false);
      });

      it('should pass with pytest command', () => {
        expect(isUnderspecifiedForExecution('ralph pytest and fix failures')).toBe(false);
      });

      it('should pass with should return assertion', () => {
        expect(isUnderspecifiedForExecution('ralph fix so it should return 200')).toBe(false);
      });

      it('should pass with stack trace reference', () => {
        expect(isUnderspecifiedForExecution('ralph fix the stack trace error')).toBe(false);
      });

      it('should still gate truly vague prompts', () => {
        expect(isUnderspecifiedForExecution('ralph fix the code')).toBe(true);
      });

      it('should still gate prompts with only stop words', () => {
        expect(isUnderspecifiedForExecution('autopilot make it work')).toBe(true);
      });
    });
  });

  describe('applyRalplanGate (issue #997)', () => {
    it('should redirect underspecified ralph to ralplan', () => {
      const result = applyRalplanGate(['ralph'], 'ralph fix this');
      expect(result.gateApplied).toBe(true);
      expect(result.keywords).toContain('ralplan');
      expect(result.keywords).not.toContain('ralph');
      expect(result.gatedKeywords).toEqual(['ralph']);
    });

    it('should redirect underspecified autopilot to ralplan', () => {
      const result = applyRalplanGate(['autopilot'], 'autopilot build the app');
      expect(result.gateApplied).toBe(true);
      expect(result.keywords).toContain('ralplan');
      expect(result.keywords).not.toContain('autopilot');
    });

    it('should redirect underspecified team to ralplan', () => {
      const result = applyRalplanGate(['team'], 'team improve performance');
      expect(result.gateApplied).toBe(true);
      expect(result.keywords).toContain('ralplan');
      expect(result.keywords).not.toContain('team');
    });

    it('should not gate well-specified ralph prompt', () => {
      const result = applyRalplanGate(['ralph'], 'ralph fix the bug in src/hooks/bridge.ts');
      expect(result.gateApplied).toBe(false);
      expect(result.keywords).toContain('ralph');
    });

    it('should not gate when cancel is present', () => {
      const result = applyRalplanGate(['cancel'], 'cancelomc ralph fix this');
      expect(result.gateApplied).toBe(false);
    });

    it('should not gate when ralplan is already present', () => {
      const result = applyRalplanGate(['ralplan'], 'ralplan fix this');
      expect(result.gateApplied).toBe(false);
    });

    it('should not gate non-execution keywords', () => {
      const result = applyRalplanGate(['tdd', 'ultrathink'], 'tdd improve it');
      expect(result.gateApplied).toBe(false);
    });

    it('should preserve non-execution keywords when gating', () => {
      const result = applyRalplanGate(['ralph', 'tdd'], 'ralph tdd fix this');
      expect(result.gateApplied).toBe(true);
      expect(result.keywords).toContain('tdd');
      expect(result.keywords).toContain('ralplan');
      expect(result.keywords).not.toContain('ralph');
    });

    it('should return empty gatedKeywords when no gate applied', () => {
      const result = applyRalplanGate([], 'regular text');
      expect(result.gateApplied).toBe(false);
      expect(result.gatedKeywords).toEqual([]);
    });

    it('should gate multiple execution keywords at once', () => {
      const result = applyRalplanGate(['ralph', 'ultrawork'], 'ralph ultrawork fix it');
      expect(result.gateApplied).toBe(true);
      expect(result.keywords).toContain('ralplan');
      expect(result.keywords).not.toContain('ralph');
      expect(result.keywords).not.toContain('ultrawork');
      expect(result.gatedKeywords).toContain('ralph');
      expect(result.gatedKeywords).toContain('ultrawork');
    });

    it('should not gate with force: escape hatch', () => {
      const result = applyRalplanGate(['ralph'], 'force: ralph fix this');
      expect(result.gateApplied).toBe(false);
      expect(result.keywords).toContain('ralph');
    });
  });

  describe('bridge pipeline regression: task-size + ralplan gate ordering', () => {
    it('should gate "ralph fix this" to ralplan even when task-size suppresses heavy modes', () => {
      // Simulate the bridge pipeline:
      // 1. getAllKeywordsWithSizeCheck suppresses ralph for small tasks
      const sizeResult = getAllKeywordsWithSizeCheck('ralph fix this', {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      // ralph is suppressed because "ralph fix this" is a small task
      expect(sizeResult.suppressedKeywords).toContain('ralph');
      expect(sizeResult.keywords).not.toContain('ralph');

      // 2. Reconstruct full keyword set (bridge fix: gate sees unsuppressed keywords)
      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      expect(fullKeywords).toContain('ralph');

      // 3. Gate evaluates on full set — should redirect to ralplan
      const gateResult = applyRalplanGate(fullKeywords, 'ralph fix this');
      expect(gateResult.gateApplied).toBe(true);
      expect(gateResult.keywords).toContain('ralplan');
      expect(gateResult.keywords).not.toContain('ralph');
    });

    it('should NOT gate well-specified small ralph prompt', () => {
      const sizeResult = getAllKeywordsWithSizeCheck('ralph fix src/hooks/bridge.ts', {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, 'ralph fix src/hooks/bridge.ts');

      // Well-specified: gate should NOT fire, ralph passes through
      expect(gateResult.gateApplied).toBe(false);
    });

    it('should suppress heavy mode normally when gate does not apply and task is small', () => {
      const sizeResult = getAllKeywordsWithSizeCheck('ralph fix src/hooks/bridge.ts', {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, 'ralph fix src/hooks/bridge.ts');

      // Gate did not fire, so use task-size-suppressed result
      expect(gateResult.gateApplied).toBe(false);
      // Task-size suppression should still apply
      expect(sizeResult.suppressedKeywords).toContain('ralph');
    });

    it('should gate correctly when keywords are NOT suppressed by size-check', () => {
      // When size-check suppression is disabled, execution keywords flow through
      // unsuppressed — the gate should still catch underspecified prompts.
      const prompt = 'ralph fix this';
      const sizeResult = getAllKeywordsWithSizeCheck(prompt, {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: false, // size-check won't suppress
      });

      // ralph is NOT suppressed (suppression disabled)
      expect(sizeResult.suppressedKeywords).toHaveLength(0);
      expect(sizeResult.keywords).toContain('ralph');

      // Gate should still fire because the prompt is underspecified
      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, prompt);
      expect(gateResult.gateApplied).toBe(true);
      expect(gateResult.keywords).toContain('ralplan');
      expect(gateResult.keywords).not.toContain('ralph');
    });

    it('should let well-specified large prompt pass through both size-check and gate', () => {
      const prompt = 'ralph fix the TypeError in src/hooks/bridge.ts function processKeywordDetector';
      const sizeResult = getAllKeywordsWithSizeCheck(prompt, {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, prompt);

      // Well-specified: gate should NOT fire
      expect(gateResult.gateApplied).toBe(false);
      // ralph should be in the final keyword list (either direct or via fullKeywords)
      expect(fullKeywords).toContain('ralph');
    });

    it('should gate autopilot on short vague prompt even when suppressed by size-check', () => {
      const prompt = 'autopilot make it better';
      const sizeResult = getAllKeywordsWithSizeCheck(prompt, {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      // autopilot is suppressed by size-check (small task)
      expect(sizeResult.suppressedKeywords).toContain('autopilot');
      expect(sizeResult.keywords).not.toContain('autopilot');

      // Reconstruct full keywords (as bridge.ts does) and gate
      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, prompt);

      // Gate should fire: redirect to ralplan
      expect(gateResult.gateApplied).toBe(true);
      expect(gateResult.keywords).toContain('ralplan');
      expect(gateResult.keywords).not.toContain('autopilot');
    });

    it('should preserve non-execution keywords through the full pipeline', () => {
      const prompt = 'ralph tdd fix this';
      const sizeResult = getAllKeywordsWithSizeCheck(prompt, {
        enabled: true,
        smallWordLimit: 50,
        largeWordLimit: 200,
        suppressHeavyModesForSmallTasks: true,
      });

      const fullKeywords = [...sizeResult.keywords, ...sizeResult.suppressedKeywords];
      const gateResult = applyRalplanGate(fullKeywords, prompt);

      // Gate fires for ralph, tdd is preserved
      expect(gateResult.gateApplied).toBe(true);
      expect(gateResult.keywords).toContain('ralplan');
      expect(gateResult.keywords).toContain('tdd');
      expect(gateResult.keywords).not.toContain('ralph');
    });
  });

  describe('non-ASCII prompt translation detection', () => {
    describe('NON_LATIN_SCRIPT_PATTERN - should trigger', () => {
      it('detects Japanese hiragana', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('UIコンポーネントを修正して')).toBe(true);
      });

      it('detects Japanese katakana', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('バグを修正してください')).toBe(true);
      });

      it('detects Chinese characters', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('修复这个错误')).toBe(true);
      });

      it('detects Korean Hangul', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('버그를 수정해주세요')).toBe(true);
      });

      it('detects Cyrillic (Russian)', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('исправь эту ошибку')).toBe(true);
      });

      it('detects Arabic', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('أصلح هذا الخطأ')).toBe(true);
      });

      it('detects Devanagari (Hindi)', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('इस बग को ठीक करें')).toBe(true);
      });

      it('detects mixed non-ASCII with English', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('ralph バグを修正して')).toBe(true);
      });
    });

    describe('NON_LATIN_SCRIPT_PATTERN - should NOT trigger', () => {
      it('does not trigger on pure ASCII', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('Fix the UI components')).toBe(false);
      });

      it('does not trigger on emoji only', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('👍 fix this bug')).toBe(false);
      });

      it('does not trigger on accented Latin (café)', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('café résumé naïve')).toBe(false);
      });

      it('does not trigger on accented Latin (Spanish)', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('arregla el error por favor')).toBe(false);
      });

      it('does not trigger on empty string', () => {
        expect(NON_LATIN_SCRIPT_PATTERN.test('')).toBe(false);
      });
    });

    describe('sanitizeForKeywordDetection strips non-ASCII from structural noise', () => {
      it('strips non-ASCII from code blocks before detection', () => {
        const text = 'Fix this: ```const x = "日本語";```';
        const sanitized = sanitizeForKeywordDetection(text);
        // After sanitization, code block content is removed
        expect(NON_LATIN_SCRIPT_PATTERN.test(sanitized)).toBe(false);
      });

      it('strips non-ASCII from URLs before detection', () => {
        const text = 'See https://example.com/path for details';
        const sanitized = sanitizeForKeywordDetection(text);
        // After sanitization, URL is removed - plain text remains
        expect(sanitized).not.toContain('https://');
      });

      it('preserves non-ASCII in plain human-language text', () => {
        const text = 'UIコンポーネントを修正して';
        const sanitized = sanitizeForKeywordDetection(text);
        // Plain Japanese text is preserved after sanitization
        expect(NON_LATIN_SCRIPT_PATTERN.test(sanitized)).toBe(true);
      });

      it('preserves non-ASCII when mixed with English keywords', () => {
        const text = 'ralph バグを修正して';
        const sanitized = sanitizeForKeywordDetection(text);
        // Japanese text preserved, English keyword also preserved
        expect(NON_LATIN_SCRIPT_PATTERN.test(sanitized)).toBe(true);
      });
    });
  });
});
