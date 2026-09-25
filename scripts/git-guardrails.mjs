#!/usr/bin/env node

/**
 * PreToolUse Hook: git guardrails.
 *
 * Blocks destructive git operations from agent-driven Bash calls with an
 * authority message. Two ways on:
 *   - OMC_GIT_GUARDRAILS=1                    (always on, any session)
 *   - an active unattended mode (ralph, autopilot, team, ultragoal)
 *     discovered from the mode state files    (dark-run default)
 * OMC_GIT_GUARDRAILS=0 always wins over both. Without either, the hook
 * exits silently.
 *
 * Blocked operations (exit code 2, stderr shown to the model):
 *   git push                      - publishing history is not an agent decision
 *   git reset --hard              - destroys uncommitted work
 *   git clean -f / --force        - destroys untracked files
 *   git branch -D                 - force-deletes a branch
 *   git checkout/restore .        - discards working-tree changes
 *
 * A guardrail must bite to count: feed it a planted violation and watch it
 * block before trusting it in a session (see refit's landing rule).
 */

import { existsSync, readFileSync } from 'fs';
import { readStdin } from './lib/stdin.mjs';
import { resolveSessionStatePathsForHook } from './lib/state-root.mjs';

const LABELS = {
  push: 'git push',
  hardReset: 'git reset --hard',
  clean: 'git clean -f',
  forceDelete: 'git branch -D',
  checkout: 'git checkout . (working-tree discard)',
  restore: 'git restore . (working-tree discard)',
};

const GUARDED_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'];

function guardMessage(label, activeMode) {
  const lines = [
    `Git guardrail: blocked "${label}".`,
    'You do not have authority for this operation - it destroys or publishes state the user owns.',
  ];
  if (activeMode) {
    lines.push(
      `Guardrails are on by default while an unattended ${activeMode} run is active; set OMC_GIT_GUARDRAILS=0 to opt out, or ask the user to run this command.`,
    );
  } else {
    lines.push(
      'Ask the user to run it themselves, or to explicitly approve it by setting OMC_GIT_GUARDRAILS=0 for this session.',
    );
  }
  return lines.join('\n');
}

function commandFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return typeof toolInput.command === 'string' ? toolInput.command : '';
}

async function activeUnattendedMode(directory, sessionId) {
  if (!sessionId) return null;

  for (const mode of GUARDED_MODES) {
    try {
      const { readPath, writePath } = await resolveSessionStatePathsForHook(
        directory,
        mode,
        sessionId,
      );
      if (!readPath || !existsSync(readPath)) continue;
      const state = JSON.parse(readFileSync(readPath, 'utf8'));
      if (!state || state.active !== true) continue;

      const stateSessionId = state.session_id ?? state.sessionId;
      if (stateSessionId && stateSessionId !== sessionId) continue;
      if (readPath !== writePath && stateSessionId !== sessionId) {
        continue;
      }
      return mode;
    } catch {
      // Unreadable or malformed state must not block a tool call.
    }
  }
  return null;
}

function backtickEnd(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
    } else if (source[index] === '`') {
      return index;
    }
  }
  return -1;
}

function commandSubstitutionEnd(source, openingParen) {
  let depth = 1;
  let quote = null;

  for (let index = openingParen + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        quote = null;
      } else if (char === '$' && next === '(') {
        depth += 1;
        index += 1;
      }
      continue;
    }

    if (char === '\\') {
      index += 1;
    } else if (char === "'") {
      quote = "'";
    } else if (char === '"') {
      quote = '"';
    } else if (char === '`') {
      const end = backtickEnd(source, index);
      if (end !== -1) index = end;
    } else if (char === '$' && next === '(') {
      depth += 1;
      index += 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function shellCommands(source) {
  // Split shell command lists while keeping quoted arguments inside their word.
  const commands = [];
  const nestedSources = [];
  let words = [];
  let word = '';
  let wordStarted = false;
  let quote = null;

  const flushWord = () => {
    if (!wordStarted) return;
    words.push(word);
    word = '';
    wordStarted = false;
  };
  const flushCommand = () => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\' && next !== undefined) {
        word += next;
        i += 1;
      } else if (char === '$' && next === '(') {
        const end = commandSubstitutionEnd(source, i + 1);
        if (end !== -1) {
          nestedSources.push(source.slice(i + 2, end));
          wordStarted = true;
          i = end;
        } else {
          word += char;
        }
      } else if (char === '`') {
        const end = backtickEnd(source, i);
        if (end !== -1) {
          nestedSources.push(source.slice(i + 1, end));
          wordStarted = true;
          i = end;
        } else {
          word += char;
        }
      } else if (char === '"') {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
    } else if (char === '\\' && next !== undefined) {
      if (next !== '\n') {
        word += next;
        wordStarted = true;
      }
      i += 1;
    } else if (char === '$' && next === '(') {
      const end = commandSubstitutionEnd(source, i + 1);
      if (end !== -1) {
        nestedSources.push(source.slice(i + 2, end));
        wordStarted = true;
        i = end;
      } else {
        word += char;
        wordStarted = true;
      }
    } else if (char === '`') {
      const end = backtickEnd(source, i);
      if (end !== -1) {
        nestedSources.push(source.slice(i + 1, end));
        wordStarted = true;
        i = end;
      } else {
        word += char;
        wordStarted = true;
      }
    } else if (char === '#' && !wordStarted) {
      while (i < source.length && source[i] !== '\n') i += 1;
      flushCommand();
    } else if (char === '\n' || char === ';' || char === '|' || char === '&') {
      flushCommand();
      if ((char === '|' || char === '&') && next === char) i += 1;
    } else if (char === '(' || char === ')') {
      flushCommand();
    } else if (/\s/.test(char)) {
      flushWord();
    } else {
      word += char;
      wordStarted = true;
    }
  }

  flushCommand();
  for (const nestedSource of nestedSources) {
    commands.push(...shellCommands(nestedSource));
  }
  return commands;
}

function commandStart(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  while (
    ['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'].includes(
      tokens[index],
    )
  ) {
    index += 1;
  }

  while (index < tokens.length) {
    const executable = tokens[index].split(/[\\/]/).pop().toLowerCase();
    if (executable === 'git' || executable === 'git.exe')
      return { executable: 'git', index };

    if (executable === 'command') {
      index += 1;
      if (tokens[index] === '-p' || tokens[index] === '--') index += 1;
      continue;
    }

    if (executable === 'exec') {
      index += 1;
      if (tokens[index] === '--') index += 1;
      else if (tokens[index] === '-a') index += 2;
      continue;
    }

    if (executable === 'nohup') {
      index += 1;
      if (tokens[index] === '--') index += 1;
      continue;
    }

    if (executable === 'time') {
      index += 1;
      while (['-p', '-v'].includes(tokens[index])) index += 1;
      if (['-f', '--format', '-o', '--output'].includes(tokens[index]))
        index += 2;
      continue;
    }

    if (executable === 'sudo') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (
          [
            '-u',
            '--user',
            '-g',
            '--group',
            '-h',
            '--host',
            '-p',
            '--prompt',
            '-C',
            '--close-from',
            '-T',
            '--command-timeout',
            '-R',
            '--chroot',
            '-D',
            '--chdir',
            '-r',
            '--role',
            '-t',
            '--type',
          ].includes(option)
        ) {
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (executable === 'env') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (
          ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(
            option,
          )
        ) {
          index += 2;
        } else {
          index += 1;
        }
      }
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
      continue;
    }

    return { executable, index };
  }

  return null;
}

function gitInvocation(tokens) {
  const command = commandStart(tokens);
  if (!command || command.executable !== 'git') return null;
  let index = command.index + 1;

  while (index < tokens.length) {
    const option = tokens[index];
    if (option === '-C' || option === '-c') {
      if (index + 1 >= tokens.length) return null;
      index += 2;
    } else if (/^-C.+/.test(option) || /^-c.+/.test(option)) {
      index += 1;
    } else {
      break;
    }
  }

  if (index >= tokens.length) return null;
  return { subcommand: tokens[index], args: tokens.slice(index + 1) };
}

function shellCommand(tokens) {
  const command = commandStart(tokens);
  if (
    !command ||
    !['sh', 'bash', 'dash', 'ash', 'ksh', 'zsh'].includes(command.executable)
  ) {
    return null;
  }

  for (let index = command.index + 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--') continue;
    if (option === '-c') return tokens[index + 1] ?? null;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) return tokens[index + 1] ?? null;
    if (!option.startsWith('-')) return null;
  }

  return null;
}

function optionsBeforeSeparator(args, valueOptions = []) {
  const values = new Set(valueOptions);
  const options = [];
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    const option = args[index];
    options.push(option);
    if (values.has(option)) index += 1;
  }
  return options;
}

function hasShortOption(options, target, valueOptions = []) {
  return options.some((option) => {
    if (!/^-[^-]+$/.test(option)) return false;
    for (const flag of option.slice(1)) {
      if (flag === target) return true;
      if (valueOptions.includes(flag)) break;
    }
    return false;
  });
}

function containsForceFlag(options, valueOptions = []) {
  return (
    options.includes('--force') || hasShortOption(options, 'f', valueOptions)
  );
}

function destructiveLabel(tokens) {
  const invocation = gitInvocation(tokens);
  if (!invocation) return null;

  const { subcommand, args } = invocation;

  if (subcommand === 'push') {
    const options = optionsBeforeSeparator(args, [
      '--repo',
      '--push-option',
      '-o',
      '--receive-pack',
      '--exec',
      '--refmap',
    ]);
    return options.some((option) => option === '--dry-run' || option === '-n')
      ? null
      : LABELS.push;
  }

  if (subcommand === 'reset') {
    const options = optionsBeforeSeparator(args);
    return options.includes('--hard') ? LABELS.hardReset : null;
  }

  if (subcommand === 'clean') {
    const options = optionsBeforeSeparator(args, ['-e', '--exclude']);
    const dryRun =
      options.includes('--dry-run') || hasShortOption(options, 'n', ['e']);
    const force = containsForceFlag(options, ['e']);
    return force && !dryRun ? LABELS.clean : null;
  }

  if (subcommand === 'branch') {
    const options = optionsBeforeSeparator(args, ['--format', '--sort']);
    const deletes = options.some(
      (option) =>
        option === '--delete' ||
        (/^-[^-]+$/.test(option) && /[dD]/.test(option.slice(1))),
    );
    return deletes &&
      (containsForceFlag(options) ||
        options.some(
          (option) => /^-[^-]+$/.test(option) && option.slice(1).includes('D'),
        ))
      ? LABELS.forceDelete
      : null;
  }

  if (subcommand === 'checkout' || subcommand === 'restore') {
    const separator = args.indexOf('--');
    const pathspecArgs = separator === -1 ? args : args.slice(separator + 1);
    const valueOptions =
      subcommand === 'checkout'
        ? new Set([
            '-b',
            '-B',
            '--branch',
            '--orphan',
            '--conflict',
            '--pathspec-from-file',
          ])
        : new Set(['-s', '--source', '--conflict', '--pathspec-from-file']);
    const pathspecs =
      separator === -1
        ? args.filter(
            (arg, index) =>
              !arg.startsWith('-') &&
              !(index > 0 && valueOptions.has(args[index - 1])),
          )
        : pathspecArgs;
    if (pathspecs.includes('.')) {
      return subcommand === 'checkout' ? LABELS.checkout : LABELS.restore;
    }
  }

  return null;
}

function destructiveCommandLabel(command) {
  const commands = shellCommands(command);
  for (let index = 0; index < commands.length; index += 1) {
    const tokens = commands[index];
    const nestedCommand = shellCommand(tokens);
    if (nestedCommand !== null) commands.push(...shellCommands(nestedCommand));
    const label = destructiveLabel(tokens);
    if (label) return label;
  }
  return null;
}

async function main() {
  if (process.env.OMC_GIT_GUARDRAILS === '0') process.exit(0);

  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const explicit = process.env.OMC_GIT_GUARDRAILS === '1';
  let activeMode = null;
  if (!explicit) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const directory =
      typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
    const sessionId =
      typeof data.session_id === 'string' ? data.session_id : undefined;
    activeMode = await activeUnattendedMode(directory, sessionId);
    if (!activeMode) process.exit(0);
  }

  const command = commandFromPayload(payload);
  if (!command) process.exit(0);

  const label = destructiveCommandLabel(command);
  if (label) {
    process.stderr.write(`${guardMessage(label, activeMode)}\n`);
    process.exit(2);
  }
  process.exit(0);
}

await main();
