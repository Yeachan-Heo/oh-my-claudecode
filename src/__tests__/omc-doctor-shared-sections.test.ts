import { describe, test, expect } from 'vitest';
import { commandWith, commands, flatCode, scriptOf, sharedSections, skillCommands, skillText } from './helpers/omc-doctor-cache-fixture.js';
import { versionCommand } from './helpers/omc-doctor-step1.js';

// Every `node -e` command of the omc-doctor skill is a standalone script: separate processes cannot share code, so the
// skill carries a copy of each helper where it is needed. A section that starts with `// == <name> (shared) ==` has the
// same text in every command that carries it, and this test keeps the copies equal. The two cache commands differ only
// in their `messages` section.
const step4 = commandWith('Latest cached plugin version') ?? '';
const step6 = commandWith("' version(s):'") ?? '';
const probe = commandWith('claudeMdEnabled') ?? '';
const npm = commandWith("'npm latest: '") ?? '';
const [outdated, stale] = [commands[0] ?? '', commands[1] ?? ''];
const step1 = versionCommand ?? '';

const named: Array<[string, string]> = [['Step 1', step1], ['npm latest command', npm], ['Step 4', step4], ['Step 6', step6], ['outdated plugin command', outdated], ['stale cache command', stale]];

// Which commands carry which shared section.
const MEMBERS: Record<string, string[]> = {
  'config dir': ['Step 1', 'Step 4', 'Step 6', 'outdated plugin command', 'stale cache command'],
  'plugin ids': ['Step 1', 'Step 4', 'Step 6', 'outdated plugin command', 'stale cache command'],
  'version grammar': ['Step 1', 'npm latest command', 'Step 4', 'Step 6', 'outdated plugin command', 'stale cache command'],
  'version order': ['Step 1', 'Step 4'],
  'read file': ['Step 1', 'Step 4', 'Step 6', 'outdated plugin command', 'stale cache command'],
  'registry marketplaces': ['Step 4', 'Step 6'],
  'registry entry shape': ['Step 1', 'outdated plugin command', 'stale cache command'],
  'path resolver': ['Step 1', 'outdated plugin command', 'stale cache command'],
  'repair constants': ['outdated plugin command', 'stale cache command'],
  'repair registry': ['outdated plugin command', 'stale cache command'],
  'occupancy records': ['outdated plugin command', 'stale cache command'],
  'modification dates': ['outdated plugin command', 'stale cache command'],
  protection: ['outdated plugin command', 'stale cache command'],
  'repair run': ['outdated plugin command', 'stale cache command'],
};

describe('omc-doctor: the commands of the skill carry equal copies of their shared sections', () => {
  test('the skill has the seven commands, each found once', () => {
    expect(skillCommands).toHaveLength(7);
    for (const [label, command] of [...named, ['opt-out probe', probe]]) expect({ label, found: command !== '' }).toEqual({ label, found: true });
    expect(commands).toHaveLength(2);
    expect(outdated).not.toBe(stale);
  });

  test('each shared section is in exactly the commands that need it', () => {
    const where: Record<string, string[]> = {};
    for (const [label, command] of named) for (const name of sharedSections(command).keys()) (where[name] ??= []).push(label);
    expect(where).toEqual(MEMBERS);
  });

  test('every copy of a shared section is the same text', () => {
    for (const [section, members] of Object.entries(MEMBERS)) {
      const copies = members.map((label) => [label, sharedSections(named.find(([l]) => l === label)?.[1] ?? '').get(section) ?? '']);
      expect(copies[0][1]).not.toBe('');
      for (const [label, copy] of copies) expect({ section, label, same: copy === copies[0][1] }).toEqual({ section, label, same: true });
    }
  });

  test('the two cache commands differ only in their messages', () => {
    const withoutMessages = (command: string) => scriptOf(command).split(/^(?=\/\/ == )/m).filter((section) => section.startsWith('// == ') && !section.startsWith('// == messages')).join('');
    expect(scriptOf(stale).split(/^(?=\/\/ == )/m).filter((section) => section.startsWith('// == messages'))).toHaveLength(1);
    expect(withoutMessages(stale)).toBe(withoutMessages(outdated));
    expect(withoutMessages(stale).length).toBeGreaterThan(5000);
  });

  // The opt-out probe is one line, so its copy of the config dir section is that section as one line (see flatCode). A
  // trailing comment would swallow the code after it in that form, so the section has whole-line comments only.
  test('the one-line opt-out probe carries the config dir section', () => {
    const section = sharedSections(step1).get('config dir') ?? '';
    expect(section).not.toBe('');
    expect(section.split('\n').filter((line) => !/^\s*\/\//.test(line) && line.includes('//'))).toEqual([]);
    expect(scriptOf(probe)).toContain(flatCode(section));
    expect(probe.includes('\n')).toBe(false);
  });
});

// A command is pasted into a double-quoted shell string, so nothing in it may be changed by one: no quote, dollar sign or
// backtick, no backslash in front of a character that a double-quoted string drops it for, and no backslash at the end of
// a line (the shell would join the lines). The skill never spells `!==` either.
describe('omc-doctor: no command contains anything a double-quoted shell string would change', () => {
  test.each([...named, ['opt-out probe', probe]] as Array<[string, string]>)('%s', (_label, command) => {
    expect(command.startsWith('node -e "')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
    const script = scriptOf(command);
    expect(script).not.toMatch(/["`$]|\\[\\"`$\n]/);
    expect(script.split('\n').filter((line) => line.endsWith('\\'))).toEqual([]);
    expect(script).not.toContain('!==');
  });

  test('the skill text never spells !==', () => {
    expect(skillText).not.toContain('!==');
  });
});
