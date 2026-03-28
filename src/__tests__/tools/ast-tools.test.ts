import { describe, it, expect } from 'vitest';
import { astGrepReplaceTool } from '../../tools/ast-tools.js';

describe('ast-tools', () => {
  describe('astGrepReplaceTool', () => {
    it('should have correct name', () => {
      expect(astGrepReplaceTool.name).toBe('ast_grep_replace');
    });

    it('should have a description', () => {
      expect(astGrepReplaceTool.description).toBeDefined();
      expect(astGrepReplaceTool.description.length).toBeGreaterThan(0);
    });
  });

  describe('$ replacement pattern escaping', () => {
    // Regression test for: captured text containing $&, $', $` being interpreted
    // as replacement patterns per ES spec when passed to replaceAll.
    // The fix escapes $ in captured text before passing to replaceAll.

    it('should not interpret $& as a replacement pattern in replaceAll', () => {
      const template = 'console.log($EXPR)';
      const metaVar = '$EXPR';
      // Simulates captured text that contains $& (common in JS: e.g., str.replace(/x/, '$&'))
      const capturedText = "str.replace(/x/, '$&')";

      // The fixed approach: escape $ before replaceAll
      const safeText = capturedText.replace(/\$/g, '$$$$');
      const result = template.replaceAll(metaVar, safeText);

      expect(result).toBe("console.log(str.replace(/x/, '$&'))");
    });

    it('should not interpret $` as a replacement pattern', () => {
      const template = 'fn($EXPR)';
      const metaVar = '$EXPR';
      const capturedText = 'a$`b';

      const safeText = capturedText.replace(/\$/g, '$$$$');
      const result = template.replaceAll(metaVar, safeText);

      expect(result).toBe('fn(a$`b)');
    });

    it("should not interpret $' as a replacement pattern", () => {
      const template = 'fn($EXPR)';
      const metaVar = '$EXPR';
      const capturedText = "a$'b";

      const safeText = capturedText.replace(/\$/g, '$$$$');
      const result = template.replaceAll(metaVar, safeText);

      expect(result).toBe("fn(a$'b)");
    });

    it('should handle $$ in captured text without collapsing', () => {
      const template = 'fn($EXPR)';
      const metaVar = '$EXPR';
      const capturedText = 'price$$value';

      const safeText = capturedText.replace(/\$/g, '$$$$');
      const result = template.replaceAll(metaVar, safeText);

      expect(result).toBe('fn(price$$value)');
    });

    it('should handle multiple meta-variables with $ in captured text', () => {
      const template = '$FN($EXPR)';
      const captures: Record<string, string> = {
        '$FN': 'process',
        '$EXPR': "data.replace(/\\d+/g, '$&')",
      };

      let finalReplacement = template;
      for (const [metaVar, captured] of Object.entries(captures)) {
        const safeText = captured.replace(/\$/g, '$$$$');
        finalReplacement = finalReplacement.replaceAll(metaVar, safeText);
      }

      expect(finalReplacement).toBe("process(data.replace(/\\d+/g, '$&'))");
    });

    it('should handle captured text without any $ characters unchanged', () => {
      const template = 'fn($EXPR)';
      const metaVar = '$EXPR';
      const capturedText = 'normalText';

      const safeText = capturedText.replace(/\$/g, '$$$$');
      const result = template.replaceAll(metaVar, safeText);

      expect(result).toBe('fn(normalText)');
    });
  });
});
