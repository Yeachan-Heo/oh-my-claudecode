/**
 * `omc ralph afk "<task>" [--verify "<command>"]...` — launch a headless,
 * narrowly-permissioned ralph session and return to the prompt.
 *
 * Reuses the factory chain's AFK link profile (scoped allowlist +
 * project,local settings) and its argv builder, so a ralph run spawned here
 * obeys the same default isolation contract as a chain link: user-level hooks
 * and settings are excluded unless OMC_AFK_INCLUDE_USER_SETTINGS=1 is set, no
 * general Bash is allowed, and only the gh/file/WebFetch surface, the
 * read-only git commands ralph's own stale-state detection needs, and exactly
 * the declared `--verify` commands are available.
 *
 * Two consequences of the default isolation shape the launch:
 * - A session with `--setting-sources project,local` cannot see
 *   plugin-bundled skills, so a `/oh-my-claudecode:ralph` prompt degrades
 *   into a plain one-shot request. The ralph skill is materialized as a
 *   PROJECT skill before launch (the chain-ring contract) and invoked as
 *   `/ralph`.
 * - The mandatory deslop pass (Step 7.5) invokes the plugin-bundled
 *   `ai-slop-cleaner` skill, which such a session equally cannot see — the
 *   pass could never complete and the loop would stall. The launch
 *   therefore injects `--no-deslop`; HITL ralph runs keep the pass.
 */

import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Command } from 'commander';
import { getSkillsDir } from '../../features/builtin-skills/skills.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync } from '../../lib/file-lock.js';
import {
  baselinePath,
  diffAgainstBaseline,
  readBaseline,
  recordBaseline,
  signatureLines,
  writeBaseline,
  type CommandBaseline,
} from '../../hooks/ralph/feedback-baseline.js';
import { findPrdPath, getPrdGoverningCriteriaRevision, getPrdStatus, readPrd, readPrdFromPath } from '../../hooks/ralph/prd.js';
import { closeoutPath, isCloseoutSatisfied, isDeslopStatus, readCloseout, writeCloseout } from '../../hooks/ralph/closeout.js';
import { executePlanActions, loadMapRecords, parseMapRef, planFromMap, renderActionOutcomes, renderMapPlan } from '../../factory/map-ingest.js';
import { composeMapPrd, finalizeMapRun, launchGate, mapRunTaskPrompt, readMapRunSidecar } from '../../factory/map-run.js';
import { defaultSpawnFn, factoryLinkArgv } from '../../hooks/session-end/spawn-next.js';
import { MAX_VERIFY_COMMANDS, MAX_VERIFY_COMMAND_LENGTH, VERIFY_COMMAND_PATTERN } from '../../hooks/session-end/routing.js';

/** Read-only git commands ralph's stale-PRD detection and gitGrep checks need. */
const RALPH_AFK_READONLY_GIT = ['git status', 'git log', 'git diff', 'git rev-parse', 'git show', 'git merge-base'];

/**
 * The session's own feedback gate must be runnable inside the session: the
 * loop's continuation context (getRalphContext), the startup notice, and the
 * skill's NON-NEGOTIABLE precondition block all call `omc ralph verify` and
 * nothing else. Prefix-matched so `--write-baseline` / `--session <id>` /
 * `--json` all pass.
 *
 * Deliberately no OMC MCP entries: a live probe of an isolated session
 * (`--setting-sources project,local`) showed the bridge MCP server does not
 * register there at all — trace_summary / state_write / state_read simply do
 * not exist, so allowlist entries for them would be cargo-cult. Consequence,
 * documented in the skill's budget rule: the token-budget stop is
 * attended-only; headless cost control is task sizing.
 */
export const RALPH_AFK_SESSION_COMMANDS = ['Bash(omc ralph verify:*)'];

/**
 * Env var carrying the launcher's declared --verify list (JSON array) into the
 * headless session. When present, `omc ralph verify` runs exactly these
 * commands and ignores the PRD's feedbackCommands and package.json detection:
 * the session can edit both with its file tools, so trusting them would turn
 * the always-granted `omc ralph verify` entry into an arbitrary-shell escape
 * from the allowlist.
 */
export const RALPH_AFK_FEEDBACK_ENV = 'OMC_RALPH_AFK_FEEDBACK';

/** The declared --verify commands that pass the same boundary check as the allowlist. */
export function afkFeedbackCommands(verifyCommands: readonly string[]): string[] {
  return verifyCommands
    .filter((command) => command.length <= MAX_VERIFY_COMMAND_LENGTH && VERIFY_COMMAND_PATTERN.test(command))
    .slice(0, MAX_VERIFY_COMMANDS);
}

/** Args (command excluded) for one headless AFK ralph launch. */
export function ralphAfkArgv(task: string, verifyCommands: readonly string[] = [], sessionId: string = randomUUID()): string[] {
  // ralph's read-only git set rides the fixed-entry slot so it never eats
  // into the MAX_VERIFY_COMMANDS budget of the declared --verify list.
  const prompt = `/ralph --no-deslop ${task}`;
  const argv = factoryLinkArgv(prompt, sessionId, verifyCommands, RALPH_AFK_READONLY_GIT);
  const toolsIdx = argv.indexOf('--allowedTools');
  if (toolsIdx !== -1) {
    argv[toolsIdx + 1] = `${argv[toolsIdx + 1]},${RALPH_AFK_SESSION_COMMANDS.join(',')}`;
  }
  return argv;
}

export type SkillMaterialization = { status: 'created'; path: string } | { status: 'present' | 'diverged'; path: string };

/**
 * Materialize the bundled ralph skill into the project's skill scope so the
 * isolated session can load it. An existing project copy is never clobbered:
 * identical content is a no-op, diverged content is reported so a stale copy
 * from an older OMC install cannot silently persist across upgrades.
 */
export function materializeRalphSkill(directory: string): SkillMaterialization | null {
  const target = join(directory, '.claude', 'skills', 'ralph', 'SKILL.md');
  const source = join(getSkillsDir(), 'ralph', 'SKILL.md');
  if (!existsSync(source)) return null;
  const bundled = readFileSync(source, 'utf8');
  if (existsSync(target)) {
    const status = readFileSync(target, 'utf8') === bundled ? 'present' : 'diverged';
    return { status, path: target };
  }
  mkdirSync(join(directory, '.claude', 'skills', 'ralph'), { recursive: true });
  copyFileSync(source, target);
  return { status: 'created', path: target };
}

export function ralphCommand(program: Command): Command {
  const cmd = program
    .command('ralph')
    .description('Ralph persistence loop launchers and feedback verification');
  cmd
    .command('afk')
    .description('Launch a headless ralph session with the factory AFK permission profile (scoped allowlist, project,local settings by default)')
    .argument('<task>', 'task description handed to the ralph loop')
    .option('--verify <command>', 'verification command the session may run (repeatable; validated like route-table verify entries)', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .addHelpText('after', `
Examples:
  $ omc ralph afk "increase test coverage on the CLI helpers" --verify "npm test" --verify "npm run build"
  The spawned session runs /ralph (with --no-deslop: the mandatory deslop
  skill is plugin-bundled and invisible to the isolated session) under the
  factory AFK allowlist, read-only git, plus exactly the declared verify
  commands. The ralph skill is materialized as a project skill
  (.claude/skills/ralph) first — add it to .gitignore if the repo does not
  already ignore .claude/.`)
    .action((task: string, options: { verify: string[] }) => {
      if ((options.verify ?? []).length > MAX_VERIFY_COMMANDS) {
        console.error(`ralph afk refused: at most ${MAX_VERIFY_COMMANDS} --verify commands are allowed (got ${options.verify.length})`);
        process.exitCode = 1;
        return;
      }
      let materialized: SkillMaterialization | null;
      try {
        materialized = materializeRalphSkill(process.cwd());
      } catch (error) {
        console.error(`ralph afk refused: could not materialize the ralph skill (${error instanceof Error ? error.message : String(error)})`);
        process.exitCode = 1;
        return;
      }
      if (materialized?.status === 'diverged') {
        console.warn(`warning: ${materialized.path} differs from the bundled ralph skill — delete it to refresh, or keep it if the divergence is intentional`);
      }
      const sessionId = randomUUID();
      // The headless session cannot see its own uuid, so executors invented
      // session names for the gate command (live smoke). Hand it over: the
      // Bash tool inherits this env, and `omc ralph verify` falls back to it.
      process.env.OMC_SESSION_ID = sessionId;
      process.env[RALPH_AFK_FEEDBACK_ENV] = JSON.stringify(afkFeedbackCommands(options.verify ?? []));
      const argv = ralphAfkArgv(task, options.verify ?? [], sessionId);
      const child = defaultSpawnFn('claude', argv, { cwd: process.cwd() }) as { pid?: number; on?: (event: string, listener: (error: Error) => void) => void };
      if (typeof child.on === 'function') {
        child.on('error', (error) => {
          console.error(`ralph afk spawn failed: ${error.message}`);
          process.exitCode = 1;
        });
      }
      if (child.pid === undefined) {
        console.error('ralph afk spawn failed: no child process was created');
        process.exitCode = 1;
        return;
      }
      console.log(`ralph afk launched (session ${sessionId})`);
      console.log(`cwd ${process.cwd()}; verify: ${(options.verify ?? []).length > 0 ? options.verify.join(', ') : '(none declared)'}`);
      if (materialized?.status === 'created') console.log(`ralph skill materialized: ${materialized.path} (consider gitignoring .claude/)`);
    });

  cmd
    .command('verify')
    .description('Judge the feedback state by diffing current failures against the session baseline (exit 0 clean, exit 1 new failures)')
    .option('--json', 'Output the judgment as JSON')
    .option('--session <id>', 'Session whose baseline to read (defaults to OMC_SESSION_ID, then a sole baseline under the state root)')
    .option('--write-baseline', 'Record the current failures as the session baseline instead of judging')
    .option('--timeout <seconds>', 'Per-command timeout in seconds (default 600; env OMC_RALPH_VERIFY_TIMEOUT_SECONDS)')
    .addHelpText('after', `
Examples:
  $ omc ralph verify --write-baseline     Record the baseline (Step 1f, first iteration)
  $ omc ralph verify                      Gate: exit 1 only when NEW failures appeared
  $ omc ralph verify --json               Machine-readable judgment
  $ omc ralph verify --session <id>       Judge another session's baseline
  $ omc ralph verify --timeout 1800       Allow 30 minutes per feedback command
  Feedback commands come from the PRD's feedbackCommands, falling back to
  package.json build/lint/test scripts. Inside an \`omc ralph afk\` session only
  the launcher's declared --verify commands run. A missing baseline is not a failure:
  verify reports the current signatures as a baseline candidate and exits 0.
  A command that exceeds the timeout is reported as timed out, not as a new
  failure: its partial output is discarded. Concurrent runs for one session are
  serialized; the second run exits 1 with a lock message.`)
    .action((options: { json?: boolean; session?: string; writeBaseline?: boolean; timeout?: string }) => {
      const timeoutMs = resolveFeedbackTimeoutMs(options.timeout);
      if (timeoutMs === null) {
        console.error('omc ralph verify: --timeout must be a positive number of seconds');
        process.exitCode = 1;
        return;
      }
      process.exitCode = ralphVerify({ ...options, timeoutMs });
    });

  cmd
    .command('from-map')
    .description('Plan a ralph run from a wayfinder map’s frontier (tracker-only; writes nothing in this mode)')
    .option('--map <repo#number>', 'Map issue reference, e.g. owner/repo#46 (repo defaults to the current repository)')
    .option('--repo <name>', 'Repository override when --map carries only a number')
    .option('--execute', 'Act on the plan: claim auto tickets (with provenance), route human gates, draft criteria for criteria-less tickets and stop for human acceptance')
    .option('--launch', 'With --execute: compose the PRD from claimed tickets and launch the loop (refuses while drafted criteria await acceptance)')
    .option('--finalize', 'Write back: close verified source tickets with evidence comments and append the map pointer (needs --session)')
    .option('--session <id>', 'Session id for --launch/--finalize (defaults to a fresh id for --launch)')
    .option('--json', 'Output the plan as JSON')
    .addHelpText('after', `
Examples:
  $ omc ralph from-map --map owner/repo#46             Plan the map's frontier (writes nothing)
  $ omc ralph from-map --map 46 --repo owner/repo --execute --launch   Claim, then launch the loop
  $ omc ralph from-map --map owner/repo#46 --finalize --session <id>    Write back a finished run
  Human-gated tickets (grilling, prototype, bare task) are routed to the
  human and NEVER claimed; a criteria-less ticket stops the run until a
  human edits and accepts its drafted criteria.`)
    .action((options: { map?: string; repo?: string; execute?: boolean; launch?: boolean; finalize?: boolean; session?: string; json?: boolean }) => {
      if (!options.map) {
        console.error('omc ralph from-map: --map <repo#number> is required');
        process.exitCode = 1;
        return;
      }
      const ref = parseMapRef(options.map, options.repo);
      if (!ref) {
        console.error(`omc ralph from-map: could not parse map reference "${options.map}"`);
        process.exitCode = 1;
        return;
      }
      const records = loadMapRecords(ref);
      const plan = planFromMap(ref, records);

      if (options.finalize) {
        const sessionId = options.session ?? process.env.OMC_SESSION_ID;
        if (!sessionId) {
          console.error('omc ralph from-map --finalize: --session <id> (or OMC_SESSION_ID) is required');
          process.exitCode = 1;
          return;
        }
        const prd = readPrd(process.cwd(), sessionId);
        if (!prd) {
          console.error(`omc ralph from-map --finalize: no PRD for session ${sessionId} under ${process.cwd()}`);
          process.exitCode = 1;
          return;
        }
        // The compose-time sidecar is the mapping's home: story notes are
        // mutable and any reviewer note replaces the source-ticket note.
        const sidecar = readMapRunSidecar(process.cwd(), sessionId);
        const stories = prd.userStories
          .map((story) => ({
            ticket: sidecar?.stories.find((entry) => entry.id === story.id)?.ticket
              ?? Number(/source-ticket: \S*#(\d+)/.exec(story.notes ?? '')?.[1] ?? 0),
            id: story.id,
            title: story.title,
            description: story.description,
            acceptanceCriteria: story.acceptanceCriteria,
          }))
          .filter((story) => story.ticket > 0);
        const outcomes = finalizeMapRun(ref, stories, prd);
        console.log(renderActionOutcomes(outcomes));
        return;
      }

      if (!options.execute) {
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else console.log(renderMapPlan(plan));
        return;
      }

      const sessionId = options.session ?? randomUUID();
      if (options.launch) {
        // claude rejects a non-UUID --session-id and dies silently (stdio is
        // ignored on the spawn path) — validate before claiming anything.
        try {
          validateSessionId(sessionId);
        } catch {
          console.error(`omc ralph from-map --launch: --session must be a UUID (got "${sessionId}")`);
          process.exitCode = 1;
          return;
        }
      }
      const outcomes = executePlanActions(plan, {
        provenance: { sessionId, mode: 'hitl', at: new Date().toISOString() },
      });
      const report = (extra?: string): void => {
        if (options.json) console.log(JSON.stringify({ plan, outcomes, ...(extra ? { note: extra } : {}) }, null, 2));
        else {
          console.log(renderMapPlan(plan));
          console.log(renderActionOutcomes(outcomes));
          if (extra) console.log(extra);
        }
      };
      if (!options.launch) {
        report();
        return;
      }
      // The launch gate reads the POST-action truth: a human may have accepted
      // a drafted ticket's criteria in the meantime.
      const gate = launchGate(outcomes, loadMapRecords(ref));
      if (!gate.ok) {
        report(`launch refused — human acceptance required:\n${gate.blocked.map((b) => `  #${b.ticket}: ${b.reason}`).join('\n')}`);
        process.exitCode = 1;
        return;
      }
      const { commands: feedbackCommands } = resolveFeedbackCommands(process.cwd());
      const composed = composeMapPrd(process.cwd(), sessionId, plan, records, { feedbackCommands });
      if (!composed.written) {
        report(`launch refused — PRD not composed: ${composed.error ?? 'unknown'}`);
        process.exitCode = 1;
        return;
      }
      process.env.OMC_SESSION_ID = sessionId;
      const argv = ralphAfkArgv(mapRunTaskPrompt(plan, composed.stories), [], sessionId);
      const child = defaultSpawnFn('claude', argv, { cwd: process.cwd() }) as { pid?: number; on?: (event: string, listener: (error: Error) => void) => void };
      if (typeof child.on === 'function') {
        child.on('error', (error) => {
          console.error(`map run spawn failed: ${error.message}`);
          process.exitCode = 1;
        });
      }
      if (child.pid === undefined) {
        console.error('map run spawn failed: no child process was created — the PRD is composed; re-run with --launch after checking `claude` is on PATH');
        process.exitCode = 1;
        return;
      }
      report(`launched (session ${sessionId}); PRD at ${composed.prdPath}; finalize with --finalize --session ${sessionId}`);
    });

  cmd
    .command('closeout')
    .description('Record or verify the session\'s terminal closeout record (Step 7.5)')
    .option('--deslop <status>', 'Record the closeout: "completed" or "skipped"')
    .option('--check', 'Verify the closeout record matches the current criteria revision')
    .option('--json', 'Output as JSON')
    .option('--session <id>', 'Session id (defaults to OMC_SESSION_ID)')
    .addHelpText('after', '\nExamples:\n  $ omc ralph closeout --deslop completed   Record the closeout after Step 6 completes\n  $ omc ralph closeout --check              Verify the closeout gate for the next step\n  $ omc ralph closeout --check --json       Machine-readable judgment\n  The closeout is a terminal record tying session completion to the criteria\n  revision that was active at completion time. Its presence gates further\n  verification steps and is required for clean session closure.')
    .action((options: { deslop?: string; check?: boolean; json?: boolean; session?: string }) => {
      process.exitCode = ralphCloseout(options);
    });

  return cmd;
}

/**
 * Feedback commands for judgment. Inside an `omc ralph afk` session only the
 * launcher-declared list counts; otherwise the PRD's declared list, else
 * package-script detection. A found but unreadable PRD returns its error
 * instead of falling through to package-script detection.
 */
export function resolveFeedbackCommands(directory: string, sessionId?: string): { commands: string[]; prdError?: string } {
  const afk = process.env[RALPH_AFK_FEEDBACK_ENV];
  if (afk !== undefined) {
    try {
      const parsed: unknown = JSON.parse(afk);
      return { commands: Array.isArray(parsed) ? afkFeedbackCommands(parsed.filter((c): c is string => typeof c === 'string')) : [] };
    } catch {
      return { commands: [] };
    }
  }
  const prdPath = findPrdPath(directory, sessionId);
  if (prdPath) {
    const { prd, error } = readPrdFromPath(prdPath);
    if (error) return { commands: [], prdError: error };
    if (prd?.feedbackCommands?.length) return { commands: [...prd.feedbackCommands] };
  }
  try {
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    // Script NAMES are not commands — `test` is not an executable; the
    // detected entries must be runnable invocations.
    const commands = ['build', 'typecheck', 'lint', 'test', 'test:run']
      .filter((name) => typeof scripts[name] === 'string')
      .map((name) => `npm run ${name}`);
    return { commands };
  } catch {
    return { commands: [] };
  }
}

const SHELL_MISSING_COMMAND_PATTERN = /^(?:[^:\r\n]*\/)?(?:sh|bash):\s*(?:(?:line\s+)?\d+:\s*)?[^:\r\n]+:\s*(?:command not found|not found)\s*$|^(?:zsh:\s*)?(?:(?:line\s+)?\d+:\s*)?command not found:\s*\S+\s*$|^['"][^'"\r\n]+['"] is not recognized as an internal or external command\b/im;

/** Default wall-clock budget for one feedback command (10 minutes). */
export const DEFAULT_FEEDBACK_TIMEOUT_MS = 600_000;

/**
 * Resolve the per-command budget: `--timeout <seconds>`, then
 * OMC_RALPH_VERIFY_TIMEOUT_SECONDS, then the 10-minute default.
 * Returns null for a value that is not a positive number of milliseconds:
 * `spawnSync` treats a 0 timeout as "no deadline", so a budget that rounds to
 * zero (for example `--timeout 0.0001`) must be rejected, not passed through.
 */
export function resolveFeedbackTimeoutMs(raw?: string): number | null {
  const value = raw ?? process.env.OMC_RALPH_VERIFY_TIMEOUT_SECONDS;
  if (value === undefined || value.trim() === '') return DEFAULT_FEEDBACK_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const timeoutMs = Math.round(seconds * 1000);
  return timeoutMs >= 1 ? timeoutMs : null;
}

/** Run one feedback command on the current tree and fingerprint its failures. */
export function runFeedbackCommand(
  command: string,
  directory: string,
  options: { timeoutMs?: number } = {},
): CommandBaseline {
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: directory,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_FEEDBACK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const errorCode = result.error && 'code' in result.error && typeof result.error.code === 'string'
      ? result.error.code
      : undefined;
    // spawnSync also reports errors after a child ran (for example, ETIMEDOUT); pid 0 means no child started.
    const failedToSpawn = Boolean(result.error) && result.pid === 0;
    if (errorCode === 'ETIMEDOUT') {
      // The process was killed mid-run. Its partial output is not failure
      // evidence, and its progress lines shift with elapsed time (issues
      // #4794/#4795), so record the timeout instead of fingerprinting it.
      return { signatures: [], timedOut: true };
    }
    // The exit code is the contract the skill gives a feedback command. A
    // command that exits 0 has no failures to fingerprint, so its success
    // output must not become a baseline signature. This matters when the
    // baseline is recorded against a check that is *designed* to fail before
    // the work starts: once the check passes, printing "all checks passed"
    // must not read as a NEW failure.
    if (result.status === 0 && !result.error) {
      return { signatures: [] };
    }
    const outputWithExecutionError = errorCode && errorCode !== 'ENOENT'
      ? `${output}\nCommand execution failed: ${errorCode}`
      : output;
    const signatures = signatureLines(outputWithExecutionError);
    const hasShellMissingCommand = SHELL_MISSING_COMMAND_PATTERN.test(output);
    const otherSignatures = hasShellMissingCommand
      ? signatureLines(output.split(/\r?\n/).filter((line) => (
        !SHELL_MISSING_COMMAND_PATTERN.test(line)
        && !/^>\s/.test(line)
        && !/^operable program or batch file\.?$/i.test(line)
      )).join('\n'))
      : signatures;
    const unrunnable = failedToSpawn
      || result.status === 126
      || result.status === 127
      || (!result.error && hasShellMissingCommand && otherSignatures.length === 0);
    const exitCode = !unrunnable && typeof result.status === 'number' ? result.status : undefined;
    return {
      signatures: unrunnable ? [] : signatures,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(unrunnable ? { unrunnable: true } : {}),
    };
  } catch (error) {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    return errorCode === 'ENOENT'
      ? { signatures: [], unrunnable: true }
      : { signatures: [`Command execution failed: ${errorCode ?? 'unknown'}`] };
  }
}

/**
 * Closeout state for the session's PRD.
 *
 * Ralph's terminal steps (the Step 7.5 deslop pass and the Step 8 closeout)
 * are prose in the skill; nothing failed when an agent skipped them. Once
 * every story is complete the gate therefore requires a record, bound to the
 * governing criteria revision so a later amendment invalidates it.
 */
export interface CloseoutGate {
  required: boolean;
  satisfied: boolean;
  criteriaRevision: string | null;
  deslop: string | null;
}

export function evaluateCloseoutGate(directory: string, stateRoot: string, sessionId: string): CloseoutGate {
  // The record is session-scoped. Without a session there is nowhere to write
  // or read it, so there is nothing to gate (verify still judges feedback).
  if (!sessionId) return { required: false, satisfied: true, criteriaRevision: null, deslop: null };
  const prdPath = findPrdPath(directory, sessionId || undefined);
  if (!prdPath) return { required: false, satisfied: true, criteriaRevision: null, deslop: null };
  const { prd } = readPrdFromPath(prdPath);
  // A PRD with no stories has finished nothing, so there is nothing to close
  // out (verify on a story-less PRD only judges feedback).
  if (!prd || prd.userStories.length === 0 || !getPrdStatus(prd).allComplete) {
    return { required: false, satisfied: true, criteriaRevision: null, deslop: null };
  }
  const criteriaRevision = getPrdGoverningCriteriaRevision(prd);
  const record = sessionId ? readCloseout(closeoutPath(stateRoot, sessionId)) : null;
  return {
    required: true,
    satisfied: isCloseoutSatisfied(record, criteriaRevision),
    criteriaRevision,
    deslop: record?.deslop ?? null,
  };
}

/** The closeout action: write a revision-bound record, or check the existing one. */
export function ralphCloseout(
  options: { deslop?: string; check?: boolean; json?: boolean; session?: string },
  directory: string = process.cwd(),
  now: Date = new Date(),
): number {
  const stateRoot = getOmcRoot(directory);
  const sessionId = options.session ?? process.env.OMC_SESSION_ID ?? '';
  if (!sessionId) {
    console.error('omc ralph closeout: no session id — pass --session <id> (or set OMC_SESSION_ID)');
    return 1;
  }
  try {
    validateSessionId(sessionId);
  } catch (error) {
    console.error(`omc ralph closeout: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const prdPath = findPrdPath(directory, sessionId);
  if (!prdPath) {
    console.error('omc ralph closeout: no PRD for this session — a closeout records a completed ralph run');
    return 1;
  }
  const { prd, error } = readPrdFromPath(prdPath);
  if (!prd) {
    console.error(`omc ralph closeout: ${error ?? 'invalid PRD'}`);
    return 1;
  }
  const criteriaRevision = getPrdGoverningCriteriaRevision(prd);
  const path = closeoutPath(stateRoot, sessionId);

  if (options.check) {
    const record = readCloseout(path);
    const satisfied = isCloseoutSatisfied(record, criteriaRevision);
    if (options.json) {
      console.log(JSON.stringify({ sessionId, satisfied, criteriaRevision, closeout: record }));
    } else if (satisfied) {
      console.log(`ralph closeout: recorded (deslop: ${record?.deslop})`);
    } else {
      console.log('ralph closeout: no record matches the current criteria revision — run `omc ralph closeout --deslop completed|skipped`');
    }
    return satisfied ? 0 : 1;
  }

  if (!getPrdStatus(prd).allComplete) {
    console.error('omc ralph closeout: the PRD still has incomplete stories — record the closeout only after Step 6 completes');
    return 1;
  }
  if (!isDeslopStatus(options.deslop)) {
    console.error('omc ralph closeout: pass --deslop completed or --deslop skipped (Step 7.5)');
    return 1;
  }
  const written = writeCloseout(path, { sessionId, deslop: options.deslop, criteriaRevision }, now);
  if (options.json) {
    console.log(JSON.stringify({ sessionId, written, path, criteriaRevision, deslop: options.deslop }));
  } else if (written) {
    console.log(`ralph closeout: recorded (deslop: ${options.deslop}) at ${path}`);
  } else {
    console.error(`omc ralph closeout: could not write ${path}`);
  }
  return written ? 0 : 1;
}

/** The verify action, extracted so tests can drive it directly. Exit code is the contract. */
export function ralphVerify(options: { json?: boolean; session?: string; writeBaseline?: boolean; timeoutMs?: number }, directory: string = process.cwd(), now: Date = new Date()): number {
  const stateRoot = getOmcRoot(directory);
  let sessionId = options.session ?? process.env.OMC_SESSION_ID ?? '';
  if (sessionId) {
    try {
      validateSessionId(sessionId);
    } catch (error) {
      console.error(`omc ralph verify: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (!sessionId) {
    // A run whose baseline was written without a session id is still findable
    // when exactly one exists; ambiguity is an error, not a guess.
    try {
      const sessionsRoot = join(stateRoot, 'state', 'sessions');
      const candidates = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(baselinePath(stateRoot, entry.name)))
        .map((entry) => entry.name);
      if (candidates.length === 1) sessionId = candidates[0];
      else if (candidates.length > 1) {
        console.error(`omc ralph verify: ${candidates.length} baselines found under ${sessionsRoot} — pass --session <id>`);
        return 1;
      }
    } catch {
      // no baselines yet
    }
  }
  const path = sessionId ? baselinePath(stateRoot, sessionId) : '';
  const readCurrentBaseline = () => (path ? readBaseline(path) : null);
  const baseline = readCurrentBaseline();
  const resolution = resolveFeedbackCommands(directory, sessionId || undefined);
  if (resolution.prdError) {
    console.error(`omc ralph verify: ${resolution.prdError}`);
    if (options.json) {
      console.log(JSON.stringify({ sessionId: sessionId || null, baselinePresent: Boolean(baseline), commands: [], newFailures: [], resolvedFailures: [], unrunnableCommands: [], error: resolution.prdError }));
    }
    return 1;
  }
  const commands = resolution.commands;

  const runGate = (): number => {
    // Re-read under the lock: a concurrent run may have re-recorded it.
    const gateBaseline = readCurrentBaseline();
    const current: Record<string, CommandBaseline> = {};
    for (const command of commands) current[command] = runFeedbackCommand(command, directory, { timeoutMs: options.timeoutMs });
    const unrunnableCommands = Object.entries(current).filter(([, entry]) => entry.unrunnable).map(([command]) => command);
    const timedOutCommands = Object.entries(current).filter(([, entry]) => entry.timedOut).map(([command]) => command);
    if (options.writeBaseline) {
      const result = path ? recordBaseline(path, current, now) : { written: false, added: 0, removed: 0 };
      const { written, previousPath } = result;
      const transitionNote = result.becameUnrunnable?.length
        ? `, ${result.becameUnrunnable.length} command${result.becameUnrunnable.length === 1 ? '' : 's'} became unrunnable (${result.becameUnrunnable.join(', ')})`
        : '';
      const note = written
        ? previousPath
          ? `baseline replaced: +${result.added} signature${result.added === 1 ? '' : 's'}, -${result.removed} signature${result.removed === 1 ? '' : 's'}${transitionNote} (previous saved at ${previousPath})`
          : `baseline recorded at ${path}`
        : path
          ? 'could not write a baseline'
          : 'could not write a baseline (no session id; pass --session)';
      if (options.json) console.log(JSON.stringify({ sessionId: sessionId || null, baselineWritten: written, previousPath: previousPath ?? null, added: result.added, removed: result.removed, becameUnrunnable: result.becameUnrunnable ?? [], commands, signatures: Object.fromEntries(Object.entries(current).map(([c, e]) => [c, e.signatures.length])), unrunnableCommands }));
      else console.log(`ralph verify: ${note}`);
      return written ? 0 : 1;
    }

    // When there are no feedback commands, current is empty; diff still evaluates properly.
    const diff = diffAgainstBaseline(gateBaseline, current);
    // A timeout already present in the baseline is environment noise, like a
    // baseline failure; a new one means the gate could not run at all.
    const newlyTimedOut = timedOutCommands.filter((command) => !gateBaseline?.commands[command]?.timedOut);
    const closeout = evaluateCloseoutGate(directory, stateRoot, sessionId || '');
    const closeoutBlocked = closeout.required && !closeout.satisfied;
    const closeoutNote = closeoutBlocked
      ? 'the PRD is complete but no closeout record matches its criteria revision; run `omc ralph closeout --deslop completed|skipped` before Step 7.6'
      : null;
    // When no feedback commands exist, still emit JSON with closeout judgment.
    if (options.json) {
      const noCommandsNote = commands.length === 0 ? 'no feedback commands: declare feedbackCommands in the PRD or add package.json build/lint/test scripts' : null;
      console.log(JSON.stringify({ sessionId: sessionId || null, baselinePresent: Boolean(gateBaseline), commands, newFailures: diff.newSignatures, resolvedFailures: diff.resolvedSignatures, unrunnableCommands, timedOutCommands, closeout, closeoutError: closeoutNote, ...(noCommandsNote ? { note: noCommandsNote } : {}) }));
      return diff.newSignatures.length > 0 || newlyTimedOut.length > 0 || closeoutBlocked ? 1 : 0;
    }
    // Report no commands case only when not outputting JSON (JSON case is above).
    if (commands.length === 0) {
      const message = 'no feedback commands: declare feedbackCommands in the PRD or add package.json build/lint/test scripts';
      if (closeoutBlocked) {
        console.log(message);
        console.log(closeoutNote);
        return 1;
      } else {
        console.log(message);
        return 0;
      }
    }

    if (newlyTimedOut.length > 0) {
      const budgetSeconds = Math.round((options.timeoutMs ?? DEFAULT_FEEDBACK_TIMEOUT_MS) / 1000);
      console.log(`ralph verify: ${newlyTimedOut.length} feedback command(s) timed out after ${budgetSeconds}s; the gate could not complete`);
      for (const command of newlyTimedOut) console.log(`  timed out: ${command}`);
      console.log('  raise the budget with --timeout <seconds> or OMC_RALPH_VERIFY_TIMEOUT_SECONDS');
      const otherNew = diff.newSignatures.filter((signature) => !signature.endsWith(': <command timed out>'));
      if (otherNew.length > 0 && gateBaseline) {
        console.log(`ralph verify: ${otherNew.length} NEW failure(s) since baseline`);
        for (const signature of otherNew) console.log(`  new: ${signature}`);
      } else if (otherNew.length > 0) {
        // Without a baseline there is nothing to diff against, so these are
        // candidates, not regressions — the same classification the
        // missing-baseline branch below uses. The timeout alone fails the gate.
        console.log(`ralph verify: no baseline for session ${sessionId || '(unknown)'} — ${otherNew.length} failure signature(s) reported as candidates, not regressions`);
        for (const signature of otherNew) console.log(`  candidate: ${signature}`);
      }
      if (closeoutNote) console.log(`ralph verify: ${closeoutNote}`);
      return 1;
    }
    if (!gateBaseline) {
      console.log(`ralph verify: no baseline for session ${sessionId || '(unknown)'} — current failures can serve as the baseline; run with --write-baseline at startup`);
      for (const signature of diff.newSignatures) console.log(`  candidate: ${signature}`);
      if (closeoutNote) {
        console.log(`ralph verify: ${closeoutNote}`);
        return 1;
      }
      return 0;
    }
    if (diff.newSignatures.length > 0) {
      console.log(`ralph verify: ${diff.newSignatures.length} NEW failure(s) since baseline`);
      for (const signature of diff.newSignatures) console.log(`  new: ${signature}`);
      if (closeoutNote) console.log(`ralph verify: ${closeoutNote}`);
      return 1;
    }
    const stillUnrunnable = unrunnableCommands.filter((command) => gateBaseline.commands[command]?.unrunnable);
    if (stillUnrunnable.length > 0) {
      console.log(`ralph verify: ${stillUnrunnable.length} feedback command(s) remain unrunnable; no comparison was possible`);
      for (const command of stillUnrunnable) console.log(`  unavailable: ${command}`);
      if (closeoutNote) console.log(`ralph verify: ${closeoutNote}`);
      return closeoutBlocked ? 1 : 0;
    }
    const note = diff.resolvedSignatures.length > 0 ? ` (${diff.resolvedSignatures.length} baseline failure(s) resolved)` : '';
    if (closeoutBlocked) {
      console.log(`ralph verify: ${closeoutNote}`);
      return 1;
    }
    console.log(`ralph verify: clean vs baseline${note}${closeout.required ? ' + closeout recorded' : ''}`);
    return 0;
  };

  if (!path) return runGate();
  // When writing the baseline, recordBaseline will acquire its own lock.
  // Only acquire the outer lock for verification (non-write) to serialize concurrent gate runs.
  if (options.writeBaseline) return runGate();
  
  // Two concurrent gates compete for the same machine and can interleave their
  // reads and re-records. Serialize on the baseline itself.
  let lock: ReturnType<typeof acquireFileLockSync> = null;
  let lockError: string | null = null;
  try {
    lock = acquireFileLockSync(lockPathFor(path));
  } catch (error) {
    lockError = error instanceof Error ? error.message : String(error);
  }
  if (!lock) {
    const message = lockError
      ? `could not acquire the session lock (${lockPathFor(path)}): ${lockError}`
      : `another verify is running for session ${sessionId} (${lockPathFor(path)})`;
    console.error(`omc ralph verify: ${message}`);
    if (options.json) {
      // A JSON consumer needs a parseable result for this outcome too.
      console.log(JSON.stringify({ sessionId: sessionId || null, baselinePresent: Boolean(readCurrentBaseline()), commands: [], newFailures: [], resolvedFailures: [], unrunnableCommands: [], error: message }));
    }
    return 1;
  }
  try {
    return runGate();
  } finally {
    releaseFileLockSync(lock);
  }
}
