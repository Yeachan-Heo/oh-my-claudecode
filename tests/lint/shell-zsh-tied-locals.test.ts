import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * zsh ties these parameters to shell state — `path`/`cdpath`/`fpath`/`manpath`/
 * `module_path` are the array views of the corresponding colon-lists, `status` is
 * `$?`, `argv` is the positional parameters, and `options`/`prompt` are shell
 * settings. Declaring one `local` inside a function therefore does not create a
 * private variable, it overwrites that shell state for the rest of the call.
 *
 * `local path="$1"` is the dangerous one: it replaces PATH with a single
 * directory, so every external command in the function silently disappears. That
 * is how validate_worktree_path came to compare a deletion candidate against the
 * caller's cwd instead of the PSM worktree root — accepting paths it exists to
 * reject. These files carry a bash shebang, but they are libraries meant to be
 * sourced, and a skill agent's shell is frequently zsh.
 */
const ZSH_TIED_NAMES = [
  'path',
  'cdpath',
  'fpath',
  'manpath',
  'module_path',
  'argv',
  'status',
  'options',
  'prompt',
] as const;

const DECLARATION = new RegExp(String.raw`^\s*(?:local|typeset|declare)\s+(?:-\w+\s+)*(${ZSH_TIED_NAMES.join('|')})\b`);

function toForwardSlash(path: string): string {
  return path.split(sep).join('/');
}

function shellFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '.git' ? [] : shellFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.sh') ? [entryPath] : [];
  });
}

describe('shell libraries', () => {
  it('never declare zsh-tied parameters as locals', () => {
    const offenders = shellFiles(join(REPO_ROOT, 'skills')).flatMap((filePath) =>
      readFileSync(filePath, 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          const match = DECLARATION.exec(line);
          return match ? [`${toForwardSlash(relative(REPO_ROOT, filePath))}:${index + 1} declares \`${match[1]}\``] : [];
        }),
    );

    expect(offenders).toEqual([]);
  });
});
