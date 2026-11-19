/**
 * Claude worker hook events (SessionStart, UserPromptSubmit, Stop, StopFailure).
 *
 * Non-bare claude workers launch with `--settings <team state root>/provider-event-hooks.json`.
 * Its hooks run scripts/team-provider-event-hook.mjs, which appends one line
 * `{"v":1,"event":...,"at":<ms>,"attempt":...}` to
 * `workers/<name>/provider-events.jsonl` under the team state root.
 *
 * The latest event is display-only: nothing decides startup, liveness,
 * recommendations, or nudges from it.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hook events the worker records. Adding an event here is the whole change. */
export const PROVIDER_EVENT_NAMES = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure'] as const;
export type ProviderEventName = (typeof PROVIDER_EVENT_NAMES)[number];

export const PROVIDER_EVENT_SETTINGS_FILE = 'provider-event-hooks.json';
export const PROVIDER_EVENTS_FILE = 'provider-events.jsonl';

export type LatestProviderEvent =
  | { event: ProviderEventName; at: number }
  | { event: 'none' };

const isProviderEventName = (value: unknown): value is ProviderEventName =>
  (PROVIDER_EVENT_NAMES as readonly unknown[]).includes(value);

/** Latest event of `attemptId`; other attempts, broken lines and `v` other than 1 are skipped. */
export function parseLatestProviderEvent(content: string, attemptId: string): LatestProviderEvent {
  let latest: LatestProviderEvent = { event: 'none' };
  for (const line of content.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const { v, event, at, attempt } = record as Record<string, unknown>;
    if (v !== 1 || attempt !== attemptId || !isProviderEventName(event)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (latest.event === 'none' || at >= latest.at) latest = { event, at };
  }
  return latest;
}

export function providerEventsPath(teamStateRoot: string, workerName: string): string {
  return join(teamStateRoot, 'workers', workerName, PROVIDER_EVENTS_FILE);
}

export async function readLatestProviderEvent(
  teamStateRoot: string,
  workerName: string,
  attemptId: string | undefined,
): Promise<LatestProviderEvent> {
  if (!attemptId) return { event: 'none' };
  let content: string;
  try {
    content = await readFile(providerEventsPath(teamStateRoot, workerName), 'utf8');
  } catch {
    return { event: 'none' };
  }
  return parseLatestProviderEvent(content, attemptId);
}

export function providerEventSettingsPath(teamStateRoot: string): string {
  return join(teamStateRoot, PROVIDER_EVENT_SETTINGS_FILE);
}

/**
 * The argv with `--settings <path>` appended for a claude worker that does not
 * run `--bare`; any other argv is returned unchanged.
 */
export function withProviderEventSettingsArgs(
  agentType: string,
  args: readonly string[],
  teamStateRoot: string,
): string[] {
  if (agentType !== 'claude' || args.includes('--bare')) return [...args];
  return [...args, '--settings', providerEventSettingsPath(teamStateRoot)];
}

function packageRoot(): string {
  if (typeof __dirname !== 'undefined' && __dirname) {
    // Bundled CJS lives in bridge/; src/team and dist/team are two levels down.
    return basename(__dirname) === 'bridge' ? join(__dirname, '..') : join(__dirname, '..', '..');
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export function providerEventHookCommand(event: ProviderEventName): string {
  const script = join(packageRoot(), 'scripts', 'team-provider-event-hook.mjs');
  return `${shellQuote(process.execPath)} ${shellQuote(script)} ${event}`;
}

/**
 * Writes the team's hook settings file; it holds no launch-attempt id. Written
 * by rename so a claude starting during a scale-up never reads half a file.
 */
export async function writeProviderEventSettings(teamStateRoot: string): Promise<string> {
  const path = providerEventSettingsPath(teamStateRoot);
  const hooks = Object.fromEntries(PROVIDER_EVENT_NAMES.map(event => [
    event,
    [{ hooks: [{ type: 'command', command: providerEventHookCommand(event) }] }],
  ]));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ hooks }, null, 2)}\n`);
  await rename(tmp, path);
  return path;
}
