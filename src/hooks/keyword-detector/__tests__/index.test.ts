import { describe, it, expect } from 'vitest';
import {
  removeCodeBlocks,
  extractPromptText,
  detectKeywordsWithType,
  hasKeyword,
  getPrimaryKeyword,
  type KeywordType,
  type DetectedKeyword,
} from '../index.js';

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

      it('should detect "don\'t stop" keyword', () => {
        const result = detectKeywordsWithType("Don't stop until done");
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeDefined();
      });

      it('should detect "must complete" keyword', () => {
        const result = detectKeywordsWithType('You must complete this task');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeDefined();
      });

      it('should detect "until done" keyword', () => {
        const result = detectKeywordsWithType('Keep going until done');
        const ralphMatch = result.find((r) => r.type === 'ralph');
        expect(ralphMatch).toBeDefined();
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

      it('should detect "autonomous" keyword', () => {
        const result = detectKeywordsWithType('Run in autonomous mode');
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

      it('should detect autopilot phrase "build me"', () => {
        const result = detectKeywordsWithType('build me a web app');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "create me"', () => {
        const result = detectKeywordsWithType('create me a new feature');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "make me"', () => {
        const result = detectKeywordsWithType('make me a dashboard');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "i want a"', () => {
        const result = detectKeywordsWithType('i want a new login page');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "handle it all"', () => {
        const result = detectKeywordsWithType('Just handle it all');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "end to end"', () => {
        const result = detectKeywordsWithType('Build this end to end');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
      });

      it('should detect autopilot phrase "e2e this"', () => {
        const result = detectKeywordsWithType('e2e this feature');
        const autopilotMatch = result.find((r) => r.type === 'autopilot');
        expect(autopilotMatch).toBeDefined();
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
    });

    describe('ultrathink keyword', () => {
      it('should detect ultrathink keyword', () => {
        const result = detectKeywordsWithType('ultrathink about this problem');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeDefined();
      });

      it('should detect think keyword', () => {
        const result = detectKeywordsWithType('think about this problem');
        const ultrathinkMatch = result.find((r) => r.type === 'ultrathink');
        expect(ultrathinkMatch).toBeDefined();
      });
    });

    describe('search keyword', () => {
      it('should detect search keyword', () => {
        const result = detectKeywordsWithType('search for files');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect find keyword', () => {
        const result = detectKeywordsWithType('find the bug');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect locate keyword', () => {
        const result = detectKeywordsWithType('locate the function');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect "where is" phrase', () => {
        const result = detectKeywordsWithType('where is the config');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect "show me" phrase', () => {
        const result = detectKeywordsWithType('show me the files');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect "list all" phrase', () => {
        const result = detectKeywordsWithType('list all components');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });

      it('should detect grep keyword', () => {
        const result = detectKeywordsWithType('grep for errors');
        const searchMatch = result.find((r) => r.type === 'search');
        expect(searchMatch).toBeDefined();
      });
    });

    describe('analyze keyword', () => {
      it('should detect analyze keyword', () => {
        const result = detectKeywordsWithType('analyze this code');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect analyse (British spelling) keyword', () => {
        const result = detectKeywordsWithType('analyse this code');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect investigate keyword', () => {
        const result = detectKeywordsWithType('investigate the issue');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect debug keyword', () => {
        const result = detectKeywordsWithType('debug this function');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect "why is" phrase', () => {
        const result = detectKeywordsWithType('why is this failing');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect "how does" phrase', () => {
        const result = detectKeywordsWithType('how does this work');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect "how to" phrase', () => {
        const result = detectKeywordsWithType('how to fix this bug');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect deep-dive keyword', () => {
        const result = detectKeywordsWithType('deep-dive into the module');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
      });

      it('should detect deepdive keyword', () => {
        const result = detectKeywordsWithType('deepdive the architecture');
        const analyzeMatch = result.find((r) => r.type === 'analyze');
        expect(analyzeMatch).toBeDefined();
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
        const text = 'autopilot and analyze this';
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

      it('should return ultrathink over search', () => {
        const result = getPrimaryKeyword('think and search');
        expect(result?.type).toBe('ultrathink');
      });

      it('should return search over analyze', () => {
        const result = getPrimaryKeyword('find and debug');
        expect(result?.type).toBe('search');
      });

      it('should return analyze when it is the only keyword', () => {
        const result = getPrimaryKeyword('analyze this code');
        expect(result?.type).toBe('analyze');
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
});
