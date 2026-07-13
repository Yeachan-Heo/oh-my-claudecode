/**
 * Shared stdin utilities for OMC hook scripts
 * Provides timeout-protected stdin reading to prevent hangs on Linux and Windows
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/240
 *
 * Mirrors templates/hooks/lib/stdin.mjs for use by plugin hook scripts.
 */

/**
 * Read all stdin with timeout to prevent indefinite hang on Linux and Windows (issue #459).
 *
 * The blocking `for await (const chunk of process.stdin)` pattern waits
 * indefinitely for EOF. On Linux, if the parent process doesn't properly
 * close stdin, this hangs forever. This function uses event-based reading
 * with a timeout as a safety net.
 *
 * @param {number} timeoutMs - Maximum time to wait for stdin (default: 5000ms)
 * @returns {Promise<string>} - The stdin content, or empty string on error/timeout
 */
export async function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    }, timeoutMs);

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });

    process.stdin.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve('');
      }
    });

    // If stdin is already ended (e.g. empty pipe), 'end' fires immediately
    // But if stdin is a TTY or never piped, we need the timeout as safety net
    if (process.stdin.readableEnded) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    }
  });
}

/**
 * Read one complete SessionEnd JSON frame under strict hook deadlines.
 *
 * @returns {Promise<
 *   | { status: 'ok', value: unknown }
 *   | { status: 'empty' | 'timeout' | 'overflow' | 'invalid' | 'error' }
 * >}
 */
export function readSessionEndFrame() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    let firstByteTimer;
    let totalTimer;

    const cleanup = () => {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };

    const finish = (result, closeStdin = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeStdin && !stdin.destroyed) {
        stdin.pause();
        stdin.destroy();
      }
      resolve(result);
    };

    const onData = (chunk) => {
      clearTimeout(firstByteTimer);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > 64 * 1024) {
        finish({ status: 'overflow' }, true);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      const input = Buffer.concat(chunks).toString('utf8');
      if (input.trim().length === 0) {
        finish({ status: 'empty' });
        return;
      }
      try {
        finish({ status: 'ok', value: JSON.parse(input) });
      } catch {
        finish({ status: 'invalid' });
      }
    };

    const onError = () => finish({ status: 'error' }, true);

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);

    if (stdin.readableEnded) {
      onEnd();
      return;
    }

    firstByteTimer = setTimeout(() => finish({ status: 'timeout' }, true), 25);
    totalTimer = setTimeout(() => finish({ status: 'timeout' }, true), 100);
    stdin.resume();
  });
}
