import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getCommand } from '../commands/index.js';

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let tempConfigDir: string;

function writeCommand(name: string, content: string): void {
  writeFileSync(join(tempConfigDir, 'commands', `${name}.md`), content, 'utf-8');
}

describe('command file frontmatter line endings', () => {
  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'omc-command-crlf-'));
    mkdirSync(join(tempConfigDir, 'commands'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    rmSync(tempConfigDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('parses LF frontmatter', () => {
    writeCommand('zz-lf', '---\ndescription: Do the thing\n---\nTemplate $ARGUMENTS\n');
    const command = getCommand('zz-lf');
    expect(command?.description).toBe('Do the thing');
    expect(command?.template).toBe('Template $ARGUMENTS\n');
  });

  it('parses CRLF frontmatter instead of leaking it into the template', () => {
    writeCommand('zz-crlf', '---\r\ndescription: Do the thing\r\n---\r\nTemplate $ARGUMENTS\r\n');
    const command = getCommand('zz-crlf');
    expect(command?.description).toBe('Do the thing');
    expect(command?.template).toBe('Template $ARGUMENTS\r\n');
    expect(command?.template).not.toContain('description:');
  });
});
