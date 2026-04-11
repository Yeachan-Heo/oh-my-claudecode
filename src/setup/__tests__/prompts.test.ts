/**
 * Tests for src/setup/prompts.ts — ReadlinePrompter & NullPrompter.
 *
 * Approach: feed a scripted stdin stream into `createReadlinePrompter` with
 * `forceInteractive: true` so the TTY guard doesn't reject the test env, then
 * assert on the captured output and resolved values. We never touch real
 * process.stdin so these tests are safe for CI.
 */

import { PassThrough } from 'stream';
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  createNullPrompter,
  createReadlinePrompter,
  InteractiveRequiredError,
  NullPrompterError,
} from '../prompts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScriptedIO {
  input: PassThrough;
  output: PassThrough;
  captured: { value: string };
}

function makeIO(): ScriptedIO {
  const input = new PassThrough();
  const output = new PassThrough();
  const captured = { value: '' };
  output.on('data', (chunk) => {
    captured.value += chunk.toString('utf-8');
  });
  return { input, output, captured };
}

function feed(io: ScriptedIO, line: string): void {
  // Scheduled on the next tick so the prompter has time to attach its
  // `rl.question` resolver before input arrives.
  setImmediate(() => {
    io.input.write(`${line}\n`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const originalIsTTY = process.stdout.isTTY;

afterEach(() => {
  // Restore in case a test mutated process.stdout.isTTY.
  if (originalIsTTY === undefined) {
    delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  } else {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = originalIsTTY;
  }
  delete process.env.CI;
  delete process.env.CLAUDE_CODE_NON_INTERACTIVE;
});

describe('createReadlinePrompter', () => {
  it('askText: returns trimmed user input', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, '  hello world  ');
    const answer = await p.askText('What is your name?');
    expect(answer).toBe('hello world');
    p.close();
  });

  it('askText: returns default on empty input', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, '');
    const answer = await p.askText('Value?', 'fallback-value');
    expect(answer).toBe('fallback-value');
    expect(io.captured.value).toContain('[fallback-value]');
    p.close();
  });

  it('askConfirm: returns default when blank', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, '');
    const answer = await p.askConfirm('Proceed?', true);
    expect(answer).toBe(true);
    p.close();
  });

  it('askConfirm: "y" → true, "n" → false', async () => {
    const io1 = makeIO();
    const p1 = createReadlinePrompter({
      input: io1.input,
      output: io1.output,
      forceInteractive: true,
    });
    feed(io1, 'y');
    expect(await p1.askConfirm('ok?', false)).toBe(true);
    p1.close();

    const io2 = makeIO();
    const p2 = createReadlinePrompter({
      input: io2.input,
      output: io2.output,
      forceInteractive: true,
    });
    feed(io2, 'no');
    expect(await p2.askConfirm('ok?', true)).toBe(false);
    p2.close();
  });

  it('askSelect: resolves by numeric index', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, '2');
    const answer = await p.askSelect(
      'Pick one',
      [
        { label: 'alpha', description: 'first' },
        { label: 'beta', description: 'second' },
        { label: 'gamma', description: 'third' },
      ],
      'alpha',
    );
    expect(answer).toBe('beta');
    p.close();
  });

  it('askSelect: resolves by label', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, 'gamma');
    const answer = await p.askSelect(
      'Pick one',
      [
        { label: 'alpha', description: 'first' },
        { label: 'beta', description: 'second' },
        { label: 'gamma', description: 'third' },
      ],
      'alpha',
    );
    expect(answer).toBe('gamma');
    p.close();
  });

  it('askSelect: falls back to default on blank / invalid input', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, '');
    const answer = await p.askSelect(
      'Pick one',
      [
        { label: 'a', description: 'first' },
        { label: 'b', description: 'second' },
      ],
      'b',
    );
    expect(answer).toBe('b');
    p.close();
  });

  it('askSecret: does not echo typed characters to output', async () => {
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    feed(io, 'super-secret-token');
    const answer = await p.askSecret('Enter API key:');
    expect(answer).toBe('super-secret-token');
    // The prompt text must be visible; the answer must NOT appear echoed.
    expect(io.captured.value).toContain('Enter API key:');
    expect(io.captured.value).not.toContain('super-secret-token');
    p.close();
  });
});

describe('createReadlinePrompter TTY guard', () => {
  it('throws InteractiveRequiredError when stdout is non-TTY and no force flag', () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    expect(() => createReadlinePrompter()).toThrow(InteractiveRequiredError);
  });

  it('throws InteractiveRequiredError when CI env is set', () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    process.env.CI = 'true';
    expect(() => createReadlinePrompter()).toThrow(InteractiveRequiredError);
  });

  it('bypasses the guard when forceInteractive: true', () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    const io = makeIO();
    const p = createReadlinePrompter({
      input: io.input,
      output: io.output,
      forceInteractive: true,
    });
    expect(p).toBeDefined();
    p.close();
  });
});

describe('createNullPrompter', () => {
  it('throws NullPrompterError on askText', async () => {
    const p = createNullPrompter();
    await expect(p.askText('name?')).rejects.toBeInstanceOf(NullPrompterError);
  });

  it('throws NullPrompterError on askConfirm', async () => {
    const p = createNullPrompter();
    await expect(p.askConfirm('ok?', true)).rejects.toBeInstanceOf(
      NullPrompterError,
    );
  });

  it('throws NullPrompterError on askSelect', async () => {
    const p = createNullPrompter();
    await expect(
      p.askSelect('pick', [{ label: 'a', description: 'x' }], 'a'),
    ).rejects.toBeInstanceOf(NullPrompterError);
  });

  it('throws NullPrompterError on askSecret, error mentions the field', async () => {
    const p = createNullPrompter();
    try {
      await p.askSecret('GITHUB_TOKEN');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NullPrompterError);
      expect((err as Error).message).toContain('GITHUB_TOKEN');
    }
  });

  it('close() is a no-op (safe to call repeatedly)', () => {
    const p = createNullPrompter();
    expect(() => {
      p.close();
      p.close();
    }).not.toThrow();
  });
});

// Silence unused import warning (vi.fn isn't needed here but we keep the
// import in case additional tests grow that need spies).
void vi;
