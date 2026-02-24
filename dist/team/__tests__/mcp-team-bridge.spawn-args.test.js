import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
describe('mcp-team-bridge spawn args', () => {
    const source = readFileSync(join(__dirname, '..', 'mcp-team-bridge.ts'), 'utf-8');
    it('includes --full-auto and --skip-git-repo-check for Codex bridge spawns (no conflicting bypass flag)', () => {
        expect(source).toMatch(/args = \['exec', '-m', model \|\| 'gpt-5\.3-codex', '--json', '--full-auto', '--skip-git-repo-check'\]/);
    });
    it('keeps Gemini bridge spawn args unchanged (no skip-git-repo-check)', () => {
        expect(source).toContain("args = ['--yolo']");
        expect(source).toMatch(/else \{\s*cmd = 'gemini';\s*args = \['--yolo'\];/s);
    });
});
//# sourceMappingURL=mcp-team-bridge.spawn-args.test.js.map