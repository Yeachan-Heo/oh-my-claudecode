import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  describe('astGrepReplaceTool meta-variable substitution', () => {
    const directories: string[] = [];

    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    async function replaceInFile(source: string, pattern: string, replacement: string, dryRun = false) {
      const directory = mkdtempSync(join(tmpdir(), 'omc-ast-replace-'));
      directories.push(directory);
      const file = join(directory, 'sample.ts');
      writeFileSync(file, source, 'utf-8');
      const result = await astGrepReplaceTool.handler({ pattern, replacement, language: 'typescript', path: directory, dryRun });
      return { text: result.content[0]?.text ?? '', content: readFileSync(file, 'utf-8') };
    }

    it('inserts the nodes a $$$ meta-variable captured, or nothing when it captured none', async () => {
      const { content } = await replaceInFile(
        'console.log("a", b);\nconsole.log();\n',
        'console.log($$$ARGS)',
        'logger.info($$$ARGS)',
      );

      expect(content).toBe('logger.info("a", b);\nlogger.info();\n');
    });

    it('applies the forEach example from the tool description', async () => {
      const { content } = await replaceInFile(
        'items.forEach((item) => { log(item); total += item; });\n',
        '$OBJ.forEach(($ITEM) => { $$$BODY })',
        'for (const $ITEM of $OBJ) { $$$BODY }',
      );

      expect(content).toBe('for (const item of items) { log(item); total += item; };\n');
    });

    it('applies the async function example from docs/TOOLS.md', async () => {
      const { content } = await replaceInFile(
        'function load(a, b) {\n  return a + b;\n}\n',
        'function $NAME($$$PARAMS) { $$$BODY }',
        'async function $NAME($$$PARAMS) { $$$BODY }',
      );

      expect(content).toBe('async function load(a, b) { return a + b; }\n');
    });

    it('inserts captured code that contains $ sequences as written', async () => {
      const multi = await replaceInFile(
        "log('$&', \"$'\", '$$', '$`');\n",
        'log($$$ARGS)',
        'info($$$ARGS)',
      );
      const single = await replaceInFile("log('$&');\n", 'log($A)', 'info($A)');

      expect(multi.content).toBe("info('$&', \"$'\", '$$', '$`');\n");
      expect(single.content).toBe("info('$&');\n");
    });

    it('does not substitute inside inserted code or inside a longer name', async () => {
      const inserted = await replaceInFile('pair($B, y);\n', 'pair($A, $B)', 'swap($A, $B)');
      const longer = await replaceInFile('pair(x, y);\n', 'pair($A, $AB)', 'swap($A, $AB)');

      expect(inserted.content).toBe('swap($B, y);\n');
      expect(longer.content).toBe('swap(x, y);\n');
    });

    it('still inserts a single capture that the replacement writes as $$$NAME', async () => {
      const { content } = await replaceInFile('console.log(x);\n', 'console.log($MSG)', 'logger.info($$$MSG)');

      expect(content).toBe('logger.info(x);\n');
    });

    it('leaves names the pattern does not capture as written', async () => {
      const { content } = await replaceInFile(
        'console.log(1, 2);\n',
        'console.log($$$ARGS)',
        'logger.info($$$OTHER, $B)',
      );

      expect(content).toBe('logger.info($$$OTHER, $B);\n');
    });

    it('keeps a $$$ that is part of a longer identifier as written', async () => {
      // price$$$USD is a plain identifier: a meta-variable is a whole node.
      const { content } = await replaceInFile(
        'const price$$$USD = 1\n',
        'const price$$$USD = $VALUE',
        'let price$$$USD = $VALUE',
      );

      expect(content).toBe('let price$$$USD = 1\n');
    });

    it('inserts $$$ captures that the replacement writes next to each other', async () => {
      const { content } = await replaceInFile(
        'if (ok) { a(); } else { b(); }\n',
        'if ($COND) { $$$THEN } else { $$$ELSE }',
        '{ $$$THEN$$$ELSE }',
      );

      expect(content).toBe('{ a();b(); }\n');
    });

    it('shows the substituted code in a dry run without writing', async () => {
      const source = 'console.log("a", b);\n';
      const { text, content } = await replaceInFile(source, 'console.log($$$ARGS)', 'logger.info($$$ARGS)', true);

      expect(text).toContain('DRY RUN');
      expect(text).toContain('+ logger.info("a", b)');
      expect(content).toBe(source);
    });

    describe('a match inside another match', () => {
      it('replaces only the outer of two matches that start at the same place', async () => {
        // a + b + c is (a + b) + c: both binary expressions start at a.
        const { content } = await replaceInFile('const s = a + b + c;\n', '$X + $Y', 'add($X, $Y)');

        expect(content).toBe('const s = add(a + b, c);\n');
      });

      it('replaces only the outer call when a matching call is its argument', async () => {
        const { content } = await replaceInFile('foo(foo(1));\n', 'foo($A)', 'barbaz($A)');

        expect(content).toBe('barbaz(foo(1));\n');
      });

      it('still replaces separate and adjacent matches on one line', async () => {
        const separate = await replaceInFile('foo(1); foo(2);\n', 'foo($A)', 'barbaz($A)');
        // The first statement ends where the second one starts.
        const adjacent = await replaceInFile('foo(1);foo(2);\n', 'foo($A);', 'bar($A);');

        expect(separate.content).toBe('barbaz(1); barbaz(2);\n');
        expect(adjacent.content).toBe('bar(1);bar(2);\n');
      });

      it('counts and shows only the replaced matches in a dry run', async () => {
        const source = 'foo(foo(1)); foo(2);\n';
        const { text, content } = await replaceInFile(source, 'foo($A)', 'barbaz($A)', true);

        expect(text).toContain('Found 2 replacement(s) in 1 file(s)');
        expect(text).toContain('- foo(foo(1))\n  + barbaz(foo(1))');
        expect(text).toContain('- foo(2)\n  + barbaz(2)');
        expect(text).not.toContain('barbaz(1)');
        expect(content).toBe(source);
      });
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
