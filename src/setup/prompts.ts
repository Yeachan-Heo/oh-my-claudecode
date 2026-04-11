/**
 * Interactive prompter — ReadlinePrompter and NullPrompter for `omc setup`.
 *
 * Plan reference: /Users/peter/.claude-personal/plans/replicated-mixing-wren.md
 *   — "Interactive prompter (`src/setup/prompts.ts`)"
 *
 * Design:
 *   - `createReadlinePrompter()` returns a Prompter backed by `readline/promises`.
 *     Throws `InteractiveRequiredError` immediately if the environment is
 *     non-interactive (no TTY, CI flag, etc.) — matches bash shim behavior of
 *     refusing to prompt in hooks or pipelines.
 *   - `createNullPrompter()` returns a Prompter whose methods always throw
 *     `NullPrompterError`. Used by `runSetup` in non-interactive mode as a
 *     sentinel so that any attempt to resolve an unset field loudly fails
 *     instead of silently hanging on a closed stdin.
 *   - `askSecret` suppresses echo by overriding the readline output writer
 *     (the only portable approach that works without going raw-mode on stdin,
 *     which would break SIGINT/Ctrl-C handling for the surrounding runSetup).
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline/promises';
import { isNonInteractive } from '../hooks/non-interactive-env/detector.js';

// ---------------------------------------------------------------------------
// Types & errors
// ---------------------------------------------------------------------------

export interface PrompterSelectOption<T extends string> {
  label: T;
  description: string;
}

export interface Prompter {
  askSelect<T extends string>(
    question: string,
    options: PrompterSelectOption<T>[],
    defaultValue: T,
  ): Promise<T>;
  askConfirm(question: string, defaultValue: boolean): Promise<boolean>;
  askText(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
}

export class InteractiveRequiredError extends Error {
  constructor(message = 'Interactive prompter requested in a non-interactive environment') {
    super(message);
    this.name = 'InteractiveRequiredError';
  }
}

export class NullPrompterError extends Error {
  constructor(field: string) {
    super(
      `NullPrompter invoked for "${field}" — non-interactive setup cannot resolve this field. `
      + 'Provide it via CLI flag, env var, or preset file.',
    );
    this.name = 'NullPrompterError';
  }
}

// ---------------------------------------------------------------------------
// ReadlinePrompter
// ---------------------------------------------------------------------------

export interface ReadlinePrompterOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Skip the TTY check — used by unit tests that feed mocked streams. */
  forceInteractive?: boolean;
}

/**
 * A readline.Interface exposes `_writeToOutput` as an internal hook used by
 * node's implementation for echo suppression. Typing it as optional makes it
 * assignable without `any`.
 */
interface InternalReadline extends ReadlineInterface {
  _writeToOutput?: (stringToWrite: string) => void;
}

export function createReadlinePrompter(opts: ReadlinePrompterOptions = {}): Prompter {
  if (!opts.forceInteractive && isNonInteractive()) {
    throw new InteractiveRequiredError(
      'omc setup requires an interactive terminal. '
      + 'Run it with a TTY, or pass --non-interactive with CLI flags / env vars / a preset.',
    );
  }

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, output }) as InternalReadline;

  const sigintHandler = (): void => {
    try {
      rl.close();
    } catch {
      // already closed
    }
  };
  rl.once('SIGINT', sigintHandler);

  async function promptLine(question: string): Promise<string> {
    return rl.question(question);
  }

  async function askText(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue && defaultValue.length > 0 ? ` [${defaultValue}]` : '';
    const answer = (await promptLine(`${question}${suffix}\n> `)).trim();
    if (answer.length === 0 && defaultValue !== undefined) {
      return defaultValue;
    }
    return answer;
  }

  async function askConfirm(question: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
    const raw = (await promptLine(`${question}${suffix}\n> `)).trim().toLowerCase();
    if (raw.length === 0) return defaultValue;
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    // Strict: re-prompt once, then give up
    const retry = (await promptLine('Please answer y or n.\n> ')).trim().toLowerCase();
    if (retry === 'y' || retry === 'yes') return true;
    if (retry === 'n' || retry === 'no') return false;
    return defaultValue;
  }

  async function askSelect<T extends string>(
    question: string,
    options: PrompterSelectOption<T>[],
    defaultValue: T,
  ): Promise<T> {
    if (options.length === 0) {
      throw new Error('askSelect requires at least one option');
    }
    const lines = [question];
    options.forEach((opt, i) => {
      const marker = opt.label === defaultValue ? '*' : ' ';
      lines.push(`  ${marker} ${i + 1}) ${opt.label} — ${opt.description}`);
    });
    lines.push(`Choose 1-${options.length} [${defaultValue}]\n> `);
    const raw = (await promptLine(lines.join('\n'))).trim();
    if (raw.length === 0) return defaultValue;

    const asIndex = Number.parseInt(raw, 10);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) {
      const hit = options[asIndex - 1];
      if (hit !== undefined) return hit.label;
    }
    const byLabel = options.find((o) => o.label === raw);
    if (byLabel) return byLabel.label;
    return defaultValue;
  }

  async function askSecret(question: string): Promise<string> {
    const originalWrite = rl._writeToOutput;
    let prefixShown = false;
    // Override the internal writer so typed characters are not echoed back,
    // but still let the prompt itself (first write) reach the user's terminal.
    rl._writeToOutput = function writeToOutput(stringToWrite: string): void {
      if (!prefixShown) {
        prefixShown = true;
        output.write(stringToWrite);
        return;
      }
      // Echo only control sequences (CR/LF) so pressing Enter still advances.
      if (stringToWrite === '\r\n' || stringToWrite === '\n' || stringToWrite === '\r') {
        output.write(stringToWrite);
      }
      // Everything else: suppressed.
    };
    try {
      const answer = await rl.question(`${question}\n> `);
      return answer.trim();
    } finally {
      rl._writeToOutput = originalWrite;
      output.write('\n');
    }
  }

  function close(): void {
    rl.off('SIGINT', sigintHandler);
    try {
      rl.close();
    } catch {
      // already closed
    }
  }

  return { askSelect, askConfirm, askText, askSecret, close };
}

// ---------------------------------------------------------------------------
// NullPrompter
// ---------------------------------------------------------------------------

export function createNullPrompter(): Prompter {
  return {
    async askSelect<T extends string>(question: string): Promise<T> {
      throw new NullPrompterError(question);
    },
    async askConfirm(question: string): Promise<boolean> {
      throw new NullPrompterError(question);
    },
    async askText(question: string): Promise<string> {
      throw new NullPrompterError(question);
    },
    async askSecret(question: string): Promise<string> {
      throw new NullPrompterError(question);
    },
    close(): void {
      // no-op
    },
  };
}
