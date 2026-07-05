#!/usr/bin/env node
import { processLazyCodexCompatHook } from './index.js';
import { createMalformedInputResult } from './malformed.js';
import { isLazyCodexCompatEventName, type LazyCodexCompatEventName } from './types.js';

function eventNameFromArg(raw: string | undefined): LazyCodexCompatEventName | undefined {
  if (!raw || !isLazyCodexCompatEventName(raw)) {
    return undefined;
  }
  return raw;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const parsedInput = rawInput.trim().length > 0 ? JSON.parse(rawInput) : {};
  const result = await processLazyCodexCompatHook(parsedInput, eventNameFromArg(process.argv[2]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const fallbackEventName = eventNameFromArg(process.argv[2]);
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify(createMalformedInputResult(fallbackEventName, message))}\n`);
});
