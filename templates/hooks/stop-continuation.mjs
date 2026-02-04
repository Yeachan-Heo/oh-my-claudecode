#!/usr/bin/env node
/**
 * OMC Stop Continuation Hook (Simplified)
 * Always allows stop - soft enforcement via message injection only.
 *
 * Uses timeout-protected stdin reading to prevent hangs on Linux.
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/240
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/385
 */

/**
 * Read stdin with timeout to prevent indefinite hang.
 */
function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    }, timeoutMs);

    process.stdin.on("data", (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });

    process.stdin.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve("");
      }
    });

    if (process.stdin.readableEnded) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    }
  });
}

async function main() {
  try {
    // Consume stdin (required for hook protocol)
    await readStdin();
    // Always allow stop
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {
    // On any error, still allow stop
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  }
}

// Safety timeout: if hook doesn't complete in 10 seconds, force exit
const safetyTimeout = setTimeout(() => {
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {
    // Ignore
  }
  process.exit(0);
}, 10000);

main().finally(() => {
  clearTimeout(safetyTimeout);
});
