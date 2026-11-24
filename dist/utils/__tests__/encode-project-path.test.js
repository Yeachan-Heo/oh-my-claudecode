import { describe, it, expect } from 'vitest';
import { encodeProjectPath } from '../encode-project-path.js';
describe('encodeProjectPath', () => {
    it('encodes a Windows drive path the way Claude Code names its project dir', () => {
        // Regression: the drive colon must be replaced with "-" so the encoded
        // directory matches Claude Code's actual project dir
        // (e.g. ~/.claude/projects/C--Users-me-proj). Before the colon was added to
        // the character class this returned "C:-Users-me-proj", which never matched
        // on Windows. Asserts on a literal string, so it runs and guards on any OS.
        expect(encodeProjectPath('C:\\Users\\me\\proj')).toBe('C--Users-me-proj');
    });
    it('encodes a POSIX path (colon replacement is a no-op there)', () => {
        expect(encodeProjectPath('/home/me/proj')).toBe('-home-me-proj');
    });
    it('replaces dots so paths with dotted segments still match', () => {
        expect(encodeProjectPath('/home/me/my.proj')).toBe('-home-me-my-proj');
    });
    it('replaces underscores so paths with underscored segments still match', () => {
        // Regression for #3329: `_` was left intact, so current-scope session_search
        // looked up ~/.claude/projects/<dir> that never existed for any path with "_".
        expect(encodeProjectPath('/home/me/00_proj/01_x')).toBe('-home-me-00-proj-01-x');
    });
    it('replaces spaces and other non-alphanumerics while preserving case', () => {
        expect(encodeProjectPath('/home/me/My Proj')).toBe('-home-me-My-Proj');
    });
});
//# sourceMappingURL=encode-project-path.test.js.map