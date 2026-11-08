import { describe, it, expect } from 'vitest';
import { encodeProjectPath as mjsEncode } from '../../scripts/lib/encode-project-path.mjs';
import { encodeProjectPath as tsEncode } from '../utils/encode-project-path.js';

// The hook runtime (context-guard-stop / pre-tool-enforcer / post-tool-verifier)
// can't import the compiled TS util, so it uses this .mjs mirror. Before the
// mirror existed the three hooks inlined `replace(/[/\\]/g, '-')`, which dropped
// dots and the Windows drive colon — so native-git-worktree transcript
// resolution looked under the wrong ~/.claude/projects/<dir> and silently found
// nothing (any repo whose path contains a dot, cross-platform; all repos on Windows).
describe('encode-project-path.mjs (hook-runtime mirror)', () => {
  it('folds path separators, dots, and the Windows drive colon', () => {
    // Literal-string assertions, so they run and guard on any OS.
    expect(mjsEncode('C:\\Users\\me\\my.app')).toBe('C--Users-me-my-app');
    expect(mjsEncode('/home/me/my.service')).toBe('-home-me-my-service');
    expect(mjsEncode('/home/me/proj')).toBe('-home-me-proj');
  });

  it('stays in sync with the canonical TS encoder (src/utils/encode-project-path.ts)', () => {
    for (const p of ['C:\\Users\\me\\my.app', '/home/me/my.service', 'D:\\a.b\\c', '/x/y/z', '/home/me/00_proj/My App']) {
      expect(mjsEncode(p)).toBe(tsEncode(p));
    }
  });
});
