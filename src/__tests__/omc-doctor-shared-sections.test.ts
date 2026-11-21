import { describe, test, expect } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCommands, bashBlocks, blockOf, codeOf, commands, GUIDE_CALL, GUIDE_GUARD, locatorLine, ROOT, runBlock, runCommand, SCRIPT, scriptSection, scriptText, skillText } from './helpers/omc-doctor-cache-fixture.js';
import { copyPluginSyncPayload } from '../installer/index.js';
import { versionCommand } from './helpers/omc-doctor-step1.js';

// The checks of the omc-doctor skill that read the plugin installation are the commands of one script that ships with
// the plugin (scripts/omc-doctor.mjs), and the skill calls them through one locator line. This file keeps that
// structure: the skill holds no code of the checks, every call uses the same locator, and the script defines each helper
// once. It also runs the locator through real bash: a missing file, an empty or wrong root, the second of two roots, a
// path with a space or with backslashes.
const posix = process.platform !== 'win32';

describe('omc-doctor: the skill calls the script through one locator, and holds no code of the checks', () => {
  test('the skill has no node -e command left: its checks are calls of the script', () => {
    expect(skillText).not.toMatch(/node -e/);
    // No inline code in a shell block either: a block is a comment, the locator line and calls, or plain shell checks.
    for (const block of bashBlocks().filter((b) => b.includes('node "$S"'))) {
      for (const line of block.split('\n')) {
        const ok = line.startsWith('#') || line === locatorLine || /^node "\$S" [a-z0-9-]+$/.test(line) || line === GUIDE_CALL || line === GUIDE_GUARD;
        expect({ line: line.slice(0, 60), ok }).toEqual({ line: line.slice(0, 60), ok: true });
      }
    }
  });

  // The one inline program left in the skill asks npm for its global root, and only inside the locator line: node runs
  // npm with a limit, because the plain command has none (and `timeout` of the shell is not on every system).
  test('the only inline program of the skill is the global package lookup of the locator, and it has a time limit', () => {
    const inline = skillText.split('\n').filter((line) => /\bnode -[pe]\b/.test(line));
    // The locator line of the six blocks that run the commands, and of the Guide block.
    expect(inline).toHaveLength(7);
    for (const line of inline) expect(line).toBe(locatorLine);
    expect(locatorLine).toContain('spawnSync("npm root -g",');
    expect(locatorLine).toContain('timeout:5000');
    expect(locatorLine).not.toMatch(/\$\(npm /);
  });

  test('the locator line is one text, in every shell block that runs the script, before the first call', () => {
    expect(locatorLine).not.toBe('');
    const withLocator = bashBlocks().filter((block) => block.split('\n').some((line) => line.startsWith('S=; ')));
    const callers = bashBlocks().filter((block) => block.includes('node "$S" '));
    expect(withLocator).toEqual(callers);
    // Six blocks run the seven commands (Step 1 and its npm line share one block), and the Guide block prints a section.
    expect(callers).toHaveLength(7);
    for (const block of callers) {
      const lines = block.split('\n');
      expect(lines.filter((line) => line.startsWith('S=; '))).toEqual([locatorLine]);
      expect(lines.indexOf(locatorLine)).toBeLessThan(lines.findIndex((line) => line.startsWith('node "$S" ')));
    }
    // CLAUDE_PLUGIN_ROOT first (the skill was loaded from that plugin, so its script matches the text), then OMC_PLUGIN_ROOT,
    // then the global npm package, which npm is asked for only when neither variable has the file.
    expect(locatorLine.indexOf('CLAUDE_PLUGIN_ROOT')).toBeLessThan(locatorLine.indexOf('OMC_PLUGIN_ROOT'));
    expect(locatorLine.indexOf('OMC_PLUGIN_ROOT')).toBeLessThan(locatorLine.indexOf('npm root -g'));
    expect(locatorLine.indexOf('done;')).toBeLessThan(locatorLine.indexOf('npm root -g'));
    expect(locatorLine).toContain('/oh-my-claude-sisyphus');
    // The first variable is the exact token the host substitutes in a skill and the compact shim of the installer names.
    expect(locatorLine).toContain('"${CLAUDE_PLUGIN_ROOT}"');
    expect(locatorLine).toContain('scripts/omc-doctor.mjs');
    expect(locatorLine).toContain('omc-doctor: plugin files not found');
    expect(locatorLine).toContain('exit 1');
  });

  test('each of the seven commands is called once, and the script knows every command the skill calls', () => {
    const called = [...skillText.matchAll(/^node "\$S" ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect([...called].sort()).toEqual([...allCommands].sort());
    const dispatch = scriptSection('dispatch');
    for (const command of called) expect({ command, known: dispatch.includes(command.includes('-') ? `'${command}'` : command) }).toEqual({ command, known: true });
  });

  test('the shell blocks of the probe and of the version commands are the comment, the locator line and the call, those of the two cache commands add the guide check', () => {
    for (const command of ['claude-md-optout', 'claude-md-version', 'cache-versions']) {
      const lines = blockOf(command).split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0].startsWith('# ')).toBe(true);
      expect(lines[1]).toBe(locatorLine);
      expect(lines[2]).toBe(`node "$S" ${command}`);
    }
    for (const command of commands) {
      const lines = blockOf(command).split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0].startsWith('# ')).toBe(true);
      expect(lines[1]).toBe(locatorLine);
      expect(lines[2]).toBe(GUIDE_GUARD);
      expect(lines[3]).toBe(`node "$S" ${command}`);
    }
  });
});

describe('omc-doctor: the script defines each helper once', () => {
  test('every section heading of the script is unique', () => {
    const headings = scriptText.split('\n').filter((line) => /^\/\/ == .+ ==$/.test(line));
    expect(headings.length).toBeGreaterThan(15);
    expect(new Set(headings).size).toBe(headings.length);
  });

  test('the helpers the commands share exist once at the top level, and no command redefines one', () => {
    const helpers = ['configDir', 'OMC_IDS', 'marketplaceOf', 'cacheDirOf', 'dropV', 'semver', 'isVersionDir', 'compareVersions', 'readFile', 'entryShapeBad', 'resolveFrom', 'linkChain', 'registryMarketplaces', 'newestChange', 'protectionOf', 'ownerGone', 'refuse', 'cacheRepair'];
    for (const name of helpers) expect({ name, definitions: scriptText.split('\n').filter((line) => line.startsWith(`const ${name} = `)).length }).toEqual({ name, definitions: 1 });
    // A helper nested in a command would be a second copy: indented definitions of these names do not exist.
    for (const name of helpers) expect({ name, nested: new RegExp(`^\\s+(const|let|function) ${name}\\b`, 'm').test(scriptText) }).toEqual({ name, nested: false });
  });

  test('the two cache commands are one function and differ only in their messages', () => {
    const messages = scriptSection('repair run');
    const entries = [...messages.matchAll(/^ {2}(outdated|stale): \{$/gm)].map((match) => match[1]);
    expect(entries).toEqual(['outdated', 'stale']);
    const keysOf = (name: string) => [...messages.slice(messages.indexOf(`  ${name}: {`)).split('\n  },')[0].matchAll(/^ {4}(\w+): /gm)].map((match) => match[1]);
    expect(keysOf('outdated')).toEqual(['movedEnd', 'allProtected', 'noPin', 'noCache', 'footer']);
    expect(keysOf('stale')).toEqual(keysOf('outdated'));
    expect(scriptText.split('const cacheRepair = ')).toHaveLength(2);
    expect(scriptSection('dispatch')).toContain("'cache-outdated': () => cacheRepair('outdated')");
    expect(scriptSection('dispatch')).toContain("'cache-stale': () => cacheRepair('stale')");
  });

  test('the script is plain Node: only built-in modules, no shell but the Windows npm call, no require', () => {
    const imports = [...scriptText.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const source of imports) expect(source.startsWith('node:')).toBe(true);
    expect(codeOf()).not.toMatch(/\brequire\(/);
    expect(codeOf().match(/shell: true/g)).toHaveLength(1);
    expect(scriptSection('Step 1: npm latest')).toContain("process.platform == 'win32'");
    expect(scriptSection('Step 1: npm latest')).toContain('shell: true');
  });

  // A command is pasted into the Bash tool as plain text: nothing in the skill may be the history expansion of a shell.
  test('the skill text never spells !==', () => {
    expect(skillText).not.toContain('!==');
  });
});

// The locator runs through real bash. A stub script in each root says which root it was found in and which command it
// was called with, so the cases below are about the lookup and not about the checks (the real script runs in the cases
// that follow).
describe.skipIf(!posix)('omc-doctor: the locator line finds the script, or says the plugin files are missing', { timeout: 120_000 }, () => {
  const stub = (parent: string, name: string, marker: string) => {
    const root = path.join(parent, name);
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'omc-doctor.mjs'), `console.log(${JSON.stringify(marker)} + ':' + process.argv.slice(2).join(' '));\n`);
    return root;
  };
  const world = () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-locator-'));
    const config = path.join(base, 'config');
    mkdirSync(path.join(config, 'plugins'), { recursive: true });
    return { base, config };
  };
  const MISSING = 'omc-doctor: plugin files not found';
  // `npm root -g` answers from npm_config_prefix, so each case gives npm a prefix of its own: the global package of the
  // machine the tests run on never decides a case. The prefix holds the package under lib/node_modules when a case asks.
  // The registry is a closed local port, so the npm latest line of Step 1 is (unavailable) at once and no case needs a network.
  const locate = (command: string, config: string, env: Record<string, string>, base: string) =>
    runBlock(command, config, { env: { npm_config_prefix: path.join(base, 'npm-prefix'), npm_config_registry: 'http://127.0.0.1:9/', npm_config_fetch_retries: '0', ...env }, cwd: base, timeout: 40_000 });

  test('no file under either root, an unset or empty root, or two roots without the file: the message and exit code 1, for every block', () => {
    const { base, config } = world();
    try {
      const bare = path.join(base, 'no-scripts');
      mkdirSync(bare);
      // A stub npm that prints nothing keeps the 35 runs of this case fast: only the global-package case below asks the real one.
      const stubBin = path.join(base, 'stub-bin');
      mkdirSync(stubBin);
      writeFileSync(path.join(stubBin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const stubbed = { PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}` };
      mkdirSync(path.join(base, 'other'));
      const settings: Array<[string, Record<string, string>]> = [
        ['both unset', { CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: '' }],
        ['blank values', { CLAUDE_PLUGIN_ROOT: '   ', OMC_PLUGIN_ROOT: '\t' }],
        ['two directories without the file', { CLAUDE_PLUGIN_ROOT: bare, OMC_PLUGIN_ROOT: path.join(base, 'other') }],
        ['roots that do not exist', { CLAUDE_PLUGIN_ROOT: path.join(base, 'gone'), OMC_PLUGIN_ROOT: path.join(base, 'gone-too') }],
        ['a root that is a file', { CLAUDE_PLUGIN_ROOT: path.join(base, 'config', 'plugins', '..', '..', 'config'), OMC_PLUGIN_ROOT: '' }],
      ];
      for (const [label, env] of settings) {
        for (const command of allCommands) {
          const result = locate(command, config, { ...stubbed, ...env }, base);
          expect({ label, command, status: result.status, first: result.stdout.split('\n')[0].slice(0, MISSING.length) }).toEqual({ label, command, status: 1, first: MISSING });
          // The message names the way out, and nothing else is printed (the checks and the cache commands never started).
          expect(result.stdout).toContain('Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode)');
          expect(result.stdout).toContain('in the global npm package');
          expect(result.stdout.trim().split('\n')).toHaveLength(1);
          expect(result.stderr).toBe('');
        }
      }
      expect(readdirSync(config)).toEqual(['plugins']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // npm is asked only when neither variable has the file, and then with a limit of 5 seconds: a npm that hangs does not
  // hold the block (before, the block waited as long as npm did), and the answer is the message of a missing file.
  test('a global npm that hangs ends the block within the limit with the message, and is not asked when a variable has the file', () => {
    const { base, config } = world();
    try {
      const stubBin = path.join(base, 'hang-bin');
      mkdirSync(stubBin);
      writeFileSync(path.join(stubBin, 'npm'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
      const hanging = { PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}` };
      const started = Date.now();
      const result = locate('claude-md-optout', config, { ...hanging, CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: '' }, base);
      expect({ status: result.status, first: result.stdout.split('\n')[0].slice(0, MISSING.length), lines: result.stdout.trim().split('\n').length, stderr: result.stderr }).toEqual({ status: 1, first: MISSING, lines: 1, stderr: '' });
      expect(Date.now() - started).toBeLessThan(20_000);
      const first = stub(base, 'first', 'first');
      const quick = Date.now();
      const found = locate('claude-md-optout', config, { ...hanging, CLAUDE_PLUGIN_ROOT: first, OMC_PLUGIN_ROOT: '' }, base);
      expect({ status: found.status, out: found.stdout.trim() }).toEqual({ status: 0, out: 'first:claude-md-optout' });
      expect(Date.now() - quick).toBeLessThan(4_000);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the first root that holds the file is used: CLAUDE_PLUGIN_ROOT, then OMC_PLUGIN_ROOT, whichever of them is wrong', () => {
    const { base, config } = world();
    try {
      const first = stub(base, 'first', 'first');
      const second = stub(base, 'second', 'second');
      const bare = path.join(base, 'bare');
      mkdirSync(bare);
      const gone = path.join(base, 'gone');
      const cases: Array<[string, Record<string, string>, string]> = [
        ['both hold the file: CLAUDE_PLUGIN_ROOT wins', { CLAUDE_PLUGIN_ROOT: first, OMC_PLUGIN_ROOT: second }, 'first'],
        ['only OMC_PLUGIN_ROOT holds it', { CLAUDE_PLUGIN_ROOT: bare, OMC_PLUGIN_ROOT: second }, 'second'],
        ['CLAUDE_PLUGIN_ROOT is empty', { CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: second }, 'second'],
        ['CLAUDE_PLUGIN_ROOT does not exist', { CLAUDE_PLUGIN_ROOT: gone, OMC_PLUGIN_ROOT: second }, 'second'],
        ['OMC_PLUGIN_ROOT does not exist beside a live CLAUDE_PLUGIN_ROOT', { CLAUDE_PLUGIN_ROOT: first, OMC_PLUGIN_ROOT: gone }, 'first'],
        ['only CLAUDE_PLUGIN_ROOT is set', { CLAUDE_PLUGIN_ROOT: first, OMC_PLUGIN_ROOT: '' }, 'first'],
        ['surrounding spaces are ignored', { CLAUDE_PLUGIN_ROOT: `  ${first}  `, OMC_PLUGIN_ROOT: '' }, 'first'],
      ];
      for (const [label, env, marker] of cases) {
        for (const command of ['claude-md-optout', 'cache-outdated']) {
          const result = locate(command, config, env, base);
          expect({ label, command, status: result.status, out: result.stdout.split('\n').filter((line) => line.includes(':')).pop() }).toEqual({ label, command, status: 0, out: `${marker}:${command}` });
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // An install without a plugin root (the npm channel) keeps the script in the global npm package: the block reaches it
  // there, and the real script answers Step 1 and the npm latest line from it.
  test('with neither variable set the script of the global npm package is used, and Step 1 prints the npm channel', () => {
    const { base, config } = world();
    try {
      const prefix = path.join(base, 'npm-prefix');
      const pkg = path.join(prefix, 'lib', 'node_modules', 'oh-my-claude-sisyphus');
      mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
      copyFileSync(SCRIPT, path.join(pkg, 'scripts', 'omc-doctor.mjs'));
      mkdirSync(path.join(config, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.2'), { recursive: true });
      for (const env of [{ CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: '' }, { CLAUDE_PLUGIN_ROOT: path.join(base, 'gone'), OMC_PLUGIN_ROOT: path.join(base, 'gone-too') }]) {
        const out = locate('step1', config, env, base);
        expect({ status: out.status, head: out.stdout.split('\n').slice(0, 3) }).toEqual({ status: 0, head: ['Channel: npm', 'Installed: 5.9.2', 'Updater: omc update'] });
        expect(out.stdout).toContain('npm latest: (unavailable)');
      }
      // A variable that holds the file wins: npm is not asked, so a package without the file changes nothing.
      const first = stub(base, 'first', 'first');
      expect(locate('cache-versions', config, { CLAUDE_PLUGIN_ROOT: first, OMC_PLUGIN_ROOT: '' }, base).stdout.trim()).toBe('first:cache-versions');
      // A global package without the script (an install too old to ship it) is the missing-files message again.
      rmSync(path.join(pkg, 'scripts', 'omc-doctor.mjs'));
      const missing = locate('step1', config, { CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: '' }, base);
      expect({ status: missing.status, first: missing.stdout.split('\n')[0].slice(0, MISSING.length) }).toEqual({ status: 1, first: MISSING });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a root whose path has spaces, parentheses, a quote, a dollar sign or a drive letter is found and its script runs', () => {
    const { base, config } = world();
    try {
      for (const name of ['with space', 'two  spaces and (parens)', 'C: Program Files (x86)', "it's quoted", 'dollar $HOME and `tick`']) {
        const root = stub(base, name, 'found');
        const result = locate('claude-md-version', config, { CLAUDE_PLUGIN_ROOT: root, OMC_PLUGIN_ROOT: '' }, base);
        expect({ name, status: result.status, out: result.stdout.trim() }).toEqual({ name, status: 0, out: 'found:claude-md-version' });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The roots decide the channel, and the script decides it from the variables, whichever copy of the file runs it.
  test('the real script from the located root: two different roots are unknown, a checkout is plugin-dir, a stale OMC root beside a live one is no conflict', () => {
    const { base, config } = world();
    try {
      const real = (name: string, version: string) => {
        const root = path.join(base, name);
        mkdirSync(path.join(root, 'scripts'), { recursive: true });
        copyFileSync(SCRIPT, path.join(root, 'scripts', 'omc-doctor.mjs'));
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
        return root;
      };
      const [one, two] = [real('one', '9.9.1'), real('two', '9.9.2')];
      const run = (env: Record<string, string>) => locate('step1', config, env, base).stdout.split('\n');
      expect(run({ CLAUDE_PLUGIN_ROOT: one, OMC_PLUGIN_ROOT: two })[0]).toBe('Channel: unknown (OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories; do not guess an updater)');
      expect(run({ CLAUDE_PLUGIN_ROOT: one, OMC_PLUGIN_ROOT: path.join(base, 'gone') }).slice(0, 3)).toEqual([`Plugin root: ${one}`, 'Channel: plugin-dir', 'Installed: 9.9.1']);
      expect(run({ CLAUDE_PLUGIN_ROOT: '', OMC_PLUGIN_ROOT: two }).slice(0, 3)).toEqual([`Plugin root: ${two}`, 'Channel: plugin-dir', 'Installed: 9.9.2']);
      // The same directory under both names is one root.
      expect(run({ CLAUDE_PLUGIN_ROOT: one, OMC_PLUGIN_ROOT: one })[1]).toBe('Channel: plugin-dir');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// The skill cannot do without the script, so the script has to reach every install: it is tracked by git (the marketplace
// and --plugin-dir installs read the checkout), it is covered by the `files` of package.json (the npm package, which the
// locator reaches through the global package), and the plugin sync of the installer copies it into the plugin cache.
// The guide file beside it (the details the skill leaves out, printed by `guide`) travels the same way: a cache repair
// stops where it is missing, so a payload without it would make the repair unusable.
// `npm run plugin:shipping:verify` does not prove any of this: its closure holds only the generated files and a few named
// scripts, so it passes with or without the file.
describe.each(['scripts/omc-doctor.mjs', 'scripts/omc-doctor-guide.md'])('omc-doctor: %s reaches every install', { timeout: 120_000 }, (script) => {
  const insideGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() === 'true';

  test.skipIf(!insideGit)('the file is tracked by git', () => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', script], { cwd: ROOT, encoding: 'utf8' });
    expect({ status: tracked.status, out: tracked.stdout.trim() }).toEqual({ status: 0, out: script });
  });

  test('the files of package.json cover the file and no pattern leaves it out', () => {
    const { files } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
    const covers = (pattern: string) => pattern === script || script.startsWith(`${pattern.replace(/\/$/, '')}/`);
    expect(files.filter((pattern) => !pattern.startsWith('!') && covers(pattern))).toContain('scripts');
    expect(files.filter((pattern) => pattern.startsWith('!') && covers(pattern.slice(1)))).toEqual([]);
  });

  test('the plugin sync copies the file into the plugin cache, byte for byte, beside the skills it compacts to shims', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-sync-'));
    try {
      // The smallest source root the installer accepts as a plugin payload, plus the real script.
      const source = path.join(base, 'source');
      const target = path.join(base, 'cache', 'omc', 'oh-my-claudecode', '9.9.9');
      for (const dir of ['.claude-plugin', 'commands', 'dist/hooks', 'bridge', 'hooks', 'skills/plan', 'scripts']) mkdirSync(path.join(source, dir), { recursive: true });
      writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode', commands: './commands/', skills: ['./skills/plan/'] }));
      writeFileSync(path.join(source, 'commands', 'omc-setup.md'), 'Read skills/omc-setup/SKILL.md and pass $ARGUMENTS.\n');
      writeFileSync(path.join(source, 'dist', 'hooks', 'skill-bridge.cjs'), 'console.log("skill bridge");\n');
      writeFileSync(path.join(source, 'bridge', 'cli.cjs'), 'console.log("bridge");\n');
      writeFileSync(path.join(source, 'bridge', 'claude-md-coordinator.cjs'), 'console.log("coordinator");\n');
      writeFileSync(path.join(source, 'hooks', 'hooks.json'), '{}\n');
      writeFileSync(path.join(source, 'skills', 'plan', 'SKILL.md'), 'name: plan\n');
      writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'oh-my-claude-sisyphus', version: '9.9.9' }));
      copyFileSync(path.join(ROOT, script), path.join(source, script));
      const result = copyPluginSyncPayload(source, [target]);
      expect(result).toEqual({ synced: true, errors: [] });
      expect(readFileSync(path.join(target, script))).toEqual(readFileSync(path.join(ROOT, script)));
      // The sync compacts the skills of the payload to shims (their bodies move to skill-bodies/); the scripts are not touched.
      expect(readFileSync(path.join(target, 'skills', 'plan', 'SKILL.md'), 'utf8')).toContain('Read and follow the full skill body');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// The script itself runs from any directory: nothing in it depends on the place it lies in or on the working directory.
describe('omc-doctor: the script runs from a directory whose path has spaces', { timeout: 120_000 }, () => {
  test('a copy in "a dir/scripts" answers Step 1 with a config directory that has a space as well, and an unknown command ends with 2', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor script '));
    try {
      const copy = path.join(base, 'a dir', 'scripts', 'omc-doctor.mjs');
      mkdirSync(path.dirname(copy), { recursive: true });
      copyFileSync(SCRIPT, copy);
      const config = path.join(base, 'config dir');
      mkdirSync(path.join(config, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0'), { recursive: true });
      const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: config, USERPROFILE: config, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' };
      const run = (...args: string[]) => spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8', cwd: path.join(base, 'a dir'), env, timeout: 20_000 });
      expect(run('step1')).toMatchObject({ status: 0, stdout: 'Channel: npm\nInstalled: 5.9.0\nUpdater: omc update\n' });
      expect(runCommand(versionCommand, config).stdout).toBe('Channel: npm\nInstalled: 5.9.0\nUpdater: omc update\n');
      for (const unknown of ['nope', 'constructor', '__proto__', '']) {
        const result = run(unknown);
        expect({ unknown, status: result.status, stdout: result.stdout }).toEqual({ unknown, status: 2, stdout: '' });
        expect(result.stderr).toContain('omc-doctor.mjs: unknown command');
      }
      expect(run().status).toBe(2);
      // The process reports win32 and the configured directory is a Windows home path with a space: the copy in the
      // directory with a space still answers, from the directory that path names.
      const windowsConfig = path.join(base, 'win config');
      mkdirSync(path.join(windowsConfig, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.1'), { recursive: true });
      const preload = path.join(base, 'platform.cjs');
      writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
      const windows = spawnSync(process.execPath, ['--require', preload, copy, 'step1'], { encoding: 'utf8', cwd: path.join(base, 'a dir'), timeout: 20_000, env: { ...env, CLAUDE_CONFIG_DIR: '~\\win config', HOME: base, USERPROFILE: base } });
      expect(windows).toMatchObject({ status: 0, stdout: 'Channel: npm\nInstalled: 5.9.1\nUpdater: omc update\n' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// Every omc-doctor test file that runs a command of the script handles paths and file systems, so it belongs in the step
// of ci.yml that runs the path-handling tests on Windows. The same remark came back for every new file of this skill.
const ciFile = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
describe.skipIf(!existsSync(ciFile))('omc-doctor: the test files run in the Windows path-handling step of ci.yml', () => {
  test('every omc-doctor test file of src/__tests__ is listed in that step', () => {
    const step = readFileSync(ciFile, 'utf8').split(/\n\s*- name: /).find((block) => block.startsWith('Run Windows path-handling tests')) ?? '';
    expect(step).not.toBe('');
    const files = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter((name) => /^omc-doctor-.*\.test\.ts$/.test(name));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((name) => !step.includes(`src/__tests__/${name}`))).toEqual([]);
  });
});

// A cleanup that the skill calls reversible must never erase an earlier recovery copy: every backup goes to a
// destination that does not exist yet, and an existing one stops the move. A fixed `<name>.bak` is not exclusive: a
// per-file `mv` into it replaces a same-name copy, and `mv` of a whole root into an existing `<name>.bak` directory
// nests the root in it instead of making the sibling copy.
describe('omc-doctor: a backup never replaces or nests into an earlier one', { timeout: 120_000 }, () => {
  // The legacy-content block: its definitions (what the model runs) and its template calls (the commented lines the
  // model uncomments after the guards and the user's consent).
  const legacy = bashBlocks().filter((block) => block.includes('# Never rm -rf here'));
  const lines = legacy[0]?.split('\n') ?? [];
  const defs = lines.filter((line) => line && !line.startsWith('#')).join('\n');
  const templates = lines.filter((line) => /^# (K|mv) /.test(line)).map((line) => line.slice(2));
  const wholeRoots = templates.filter((line) => !/[.]md\b/.test(line)).join('\n');
  const perFile = templates.filter((line) => /deepsearch[.]md/.test(line));

  const fixture = () => ({ dir: mkdtempSync(path.join(tmpdir(), 'omc-doctor-backup-')) });
  const bash = (dir: string, script: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, ...env } });
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const backupsOf = (dir: string, root: string) => readdirSync(dir).filter((name) => name.startsWith(root + '.bak')).sort();
  // A date that does not change, so that two calls in one shell ask for the same destination.
  const frozenDate = () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'omc-doctor-backup-bin-'));
    writeFileSync(path.join(bin, 'date'), '#!/bin/sh\necho 20260101000000\n');
    chmodSync(path.join(bin, 'date'), 0o755);
    return { bin, PATH: bin + path.delimiter + (process.env.PATH ?? '') };
  };

  test('the block documents one move for whole roots and one for single files, both through the same definition', () => {
    expect(legacy).toHaveLength(1);
    expect(defs).toContain('K() {');
    expect(templates.filter((line) => /^K (agents|commands|skills)$/.test(line))).toHaveLength(3);
    expect(perFile).toEqual(['K commands deepsearch.md']);
  });

  describe.skipIf(process.platform === 'win32')('run twice in a configuration directory', () => {
    test('whole roots: the second run makes another sibling and leaves the first copy as it was, nothing is nested', () => {
      const { dir } = fixture();
      try {
        const roots = ['agents', 'commands', 'skills'];
        for (const text of ['first', 'second']) {
          for (const root of roots) put(path.join(dir, root, 'OMC.md'), text);
          const run = bash(dir, defs + '\n' + wholeRoots);
          expect({ text, status: run.status, stderr: run.stderr }).toEqual({ text, status: 0, stderr: '' });
          for (const root of roots) expect(existsSync(path.join(dir, root))).toBe(false);
        }
        for (const root of roots) {
          const copies = backupsOf(dir, root);
          expect({ root, copies: copies.length }).toEqual({ root, copies: 2 });
          // Each copy is the root as it was: its file and nothing else (no root nested in the other copy).
          const held = copies.map((name) => ({ listing: readdirSync(path.join(dir, name)), text: readFileSync(path.join(dir, name, 'OMC.md'), 'utf8') }));
          expect({ root, held: held.map((copy) => copy.text).sort() }).toEqual({ root, held: ['first', 'second'] });
          for (const copy of held) expect(copy.listing).toEqual(['OMC.md']);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('single files: a same-name file of an earlier run stays in the earlier copy, the custom file stays in place', () => {
      const { dir } = fixture();
      try {
        for (const text of ['first', 'second']) {
          put(path.join(dir, 'commands', 'deepsearch.md'), text);
          put(path.join(dir, 'commands', 'custom.md'), 'mine');
          const run = bash(dir, defs + '\n' + perFile.join('\n'));
          expect({ text, status: run.status, stderr: run.stderr }).toEqual({ text, status: 0, stderr: '' });
          expect(readdirSync(path.join(dir, 'commands')).sort()).toEqual(['custom.md']);
        }
        const copies = backupsOf(dir, 'commands');
        expect(copies).toHaveLength(2);
        const held = copies.map((name) => ({ listing: readdirSync(path.join(dir, name)), text: readFileSync(path.join(dir, name, 'deepsearch.md'), 'utf8') }));
        expect(held.map((copy) => copy.text).sort()).toEqual(['first', 'second']);
        for (const copy of held) expect(copy.listing).toEqual(['deepsearch.md']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(process.platform === 'win32')('a destination that exists stops the move', () => {
    // The same instant and the same shell ask for the same name twice: the second call must refuse.
    test('two moves in one shell at one instant: the second refuses and moves nothing', () => {
      const { dir } = fixture();
      const { bin, PATH } = frozenDate();
      try {
        put(path.join(dir, 'agents', 'OMC.md'), 'first');
        put(path.join(dir, 'commands', 'deepsearch.md'), 'first');
        const run = bash(
          dir,
          [
            defs,
            'K agents; echo "first-agents=$?"',
            'mkdir -p "$C/agents" && echo second > "$C/agents/OMC.md"',
            'K agents; echo "second-agents=$?"',
            'K commands deepsearch.md; echo "first-file=$?"',
            'echo second > "$C/commands/deepsearch.md"',
            'K commands deepsearch.md; echo "second-file=$?"',
          ].join('\n'),
          { PATH },
        );
        expect(run.stdout.trim().split('\n')).toEqual(['first-agents=0', 'second-agents=1', 'first-file=0', 'second-file=1']);
        expect(run.stderr.match(/Nothing moved: .* exists/g)).toHaveLength(2);
        // The second root and file are where they were, the first copies are untouched.
        expect(readFileSync(path.join(dir, 'agents', 'OMC.md'), 'utf8')).toBe('second\n');
        expect(readFileSync(path.join(dir, 'commands', 'deepsearch.md'), 'utf8')).toBe('second\n');
        for (const [root, file] of [['agents', 'OMC.md'], ['commands', 'deepsearch.md']]) {
          const copies = backupsOf(dir, root);
          expect(copies).toHaveLength(1);
          expect(readdirSync(path.join(dir, copies[0]))).toEqual([file]);
          expect(readFileSync(path.join(dir, copies[0], file), 'utf8')).toBe('first');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    });

    test.each([
      ['a directory with a copy of an earlier cleanup', 'dir'],
      ['a link to nothing', 'dangling link'],
      ['a file', 'file'],
    ])('%s at the destination: nothing is moved into it and it is not touched', (_name, kind) => {
      const { dir } = fixture();
      const { bin, PATH } = frozenDate();
      try {
        put(path.join(dir, 'agents', 'OMC.md'), 'live');
        put(path.join(dir, 'commands', 'deepsearch.md'), 'live');
        // The destination K asks for: the frozen date and the pid of the shell that runs it.
        const occupy = (root: string) => {
          const target = `"$C/${root}.bak-20260101000000-$$"`;
          return kind === 'dir' ? `mkdir ${target} && echo earlier > ${target}/OMC.md` : kind === 'file' ? `echo earlier > ${target}` : `ln -s /nonexistent/earlier ${target}`;
        };
        const run = bash(dir, [defs, occupy('agents'), 'K agents; echo "agents=$?"', occupy('commands'), 'K commands deepsearch.md; echo "file=$?"'].join('\n'), { PATH });
        expect(run.stdout.trim().split('\n')).toEqual(['agents=1', 'file=1']);
        // K says so itself (a link to nothing would make mv fail anyway, but with a message about mv).
        expect(run.stderr.match(/Nothing moved: .* exists/g)).toHaveLength(2);
        expect(readFileSync(path.join(dir, 'agents', 'OMC.md'), 'utf8')).toBe('live');
        expect(readFileSync(path.join(dir, 'commands', 'deepsearch.md'), 'utf8')).toBe('live');
        for (const root of ['agents', 'commands']) {
          const copies = backupsOf(dir, root);
          expect(copies).toHaveLength(1);
          if (kind === 'dir') expect(readdirSync(path.join(dir, copies[0]))).toEqual(['OMC.md']);
          if (kind === 'dir') expect(readFileSync(path.join(dir, copies[0], 'OMC.md'), 'utf8')).toBe('earlier\n');
          if (kind === 'file') expect(readFileSync(path.join(dir, copies[0]), 'utf8')).toBe('earlier\n');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    });
  });

  describe('the CLAUDE.md fix and the stated rule', () => {
    const section = (heading: string) => {
      const start = skillText.indexOf(`### ${heading}`);
      return skillText.slice(start, skillText.indexOf('\n### ', start + 1) === -1 ? undefined : skillText.indexOf('\n### ', start + 1));
    };

    test('the CLAUDE.md fix copies an existing file to a new destination before it writes', () => {
      const fix = section('Fix: Missing/Outdated CLAUDE.md');
      expect(fix).toContain('When that file exists, first copy it (`cp -n -p`) to a new `CLAUDE.md.bak-<UTC time>-<pid>` beside it and write only after the copy succeeded');
      expect(fix).toContain('if it fails, leave CLAUDE.md as it is and say so');
    });

    test('the legacy section names the rule once: a destination that does not exist yet, never a fixed .bak name', () => {
      const text = section('Fix: Legacy Curl-Installed Content');
      expect(text).toContain('a reversible move (`mv`) to a sibling backup that does not exist yet, `<name>.bak-<UTC time>-<pid>`, made by `K` below, which stops when that name exists');
      expect(text).toContain('a fixed `.bak` name is replaced or nested into by a second run');
      expect(text).toContain('(`K commands <file>...`)');
      expect(text).not.toMatch(/into `commands[.]bak\/`/);
    });
  });
});
