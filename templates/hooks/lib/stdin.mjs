/**
 * Shared stdin utilities for OMC hooks
 * Provides timeout-protected stdin reading to prevent hangs on Linux and Windows
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/240
 */

/**
 * Read all stdin with timeout to prevent indefinite hang on Linux and Windows.
 *
 * The blocking `for await (const chunk of process.stdin)` pattern waits
 * indefinitely for EOF. On Linux, if the parent process doesn't properly
 * close stdin, this hangs forever. This function uses event-based reading
 * with a timeout as a safety net.
 *
 * @param {number} timeoutMs - Maximum time to wait for stdin (default: 2000ms)
 * @returns {Promise<string>} - The stdin content, or empty string on error/timeout
 */
export async function readStdin(timeoutMs = 2000) {
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
