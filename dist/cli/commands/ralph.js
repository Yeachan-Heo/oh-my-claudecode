/**
 * `omc ralph afk "<task>" [--verify "<command>"]...` — launch a headless,
 * narrowly-permissioned ralph session and return to the prompt.
 *
 * Reuses the factory chain's AFK link profile (scoped allowlist +
 * project,local settings) and its argv builder, so a ralph run spawned here
 * obeys the same isolation contract as a chain link: no user-level hooks or
 * settings, no general Bash — only the gh/file/WebFetch surface, the
 * read-only git commands ralph's own stale-state detection needs, and
 * exactly the declared `--verify` commands.
 *
 * Two consequences of that isolation shape the launch:
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
import { getSkillsDir } from '../../features/builtin-skills/skills.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';
import { baselinePath, diffAgainstBaseline, readBaseline, signatureLines, writeBaseline, } from '../../hooks/ralph/feedback-baseline.js';
import { readPrd } from '../../hooks/ralph/prd.js';
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
export function afkFeedbackCommands(verifyCommands) {
    return verifyCommands
        .filter((command) => command.length <= MAX_VERIFY_COMMAND_LENGTH && VERIFY_COMMAND_PATTERN.test(command))
        .slice(0, MAX_VERIFY_COMMANDS);
}
/** Args (command excluded) for one headless AFK ralph launch. */
export function ralphAfkArgv(task, verifyCommands = [], sessionId = randomUUID()) {
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
/**
 * Materialize the bundled ralph skill into the project's skill scope so the
 * isolated session can load it. An existing project copy is never clobbered:
 * identical content is a no-op, diverged content is reported so a stale copy
 * from an older OMC install cannot silently persist across upgrades.
 */
export function materializeRalphSkill(directory) {
    const target = join(directory, '.claude', 'skills', 'ralph', 'SKILL.md');
    const source = join(getSkillsDir(), 'ralph', 'SKILL.md');
    if (!existsSync(source))
        return null;
    const bundled = readFileSync(source, 'utf8');
    if (existsSync(target)) {
        const status = readFileSync(target, 'utf8') === bundled ? 'present' : 'diverged';
        return { status, path: target };
    }
    mkdirSync(join(directory, '.claude', 'skills', 'ralph'), { recursive: true });
    copyFileSync(source, target);
    return { status: 'created', path: target };
}
export function ralphCommand(program) {
    const cmd = program
        .command('ralph')
        .description('Ralph persistence loop launchers and feedback verification');
    cmd
        .command('afk')
        .description('Launch a headless ralph session with the factory AFK permission profile (scoped allowlist, project,local settings)')
        .argument('<task>', 'task description handed to the ralph loop')
        .option('--verify <command>', 'verification command the session may run (repeatable; validated like route-table verify entries)', (value, previous) => [...previous, value], [])
        .addHelpText('after', `
Examples:
  $ omc ralph afk "increase test coverage on the CLI helpers" --verify "npm test" --verify "npm run build"
  The spawned session runs /ralph (with --no-deslop: the mandatory deslop
  skill is plugin-bundled and invisible to the isolated session) under the
  factory AFK allowlist, read-only git, plus exactly the declared verify
  commands. The ralph skill is materialized as a project skill
  (.claude/skills/ralph) first — add it to .gitignore if the repo does not
  already ignore .claude/.`)
        .action((task, options) => {
        if ((options.verify ?? []).length > MAX_VERIFY_COMMANDS) {
            console.error(`ralph afk refused: at most ${MAX_VERIFY_COMMANDS} --verify commands are allowed (got ${options.verify.length})`);
            process.exitCode = 1;
            return;
        }
        let materialized;
        try {
            materialized = materializeRalphSkill(process.cwd());
        }
        catch (error) {
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
        const child = defaultSpawnFn('claude', argv, { cwd: process.cwd() });
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
        if (materialized?.status === 'created')
            console.log(`ralph skill materialized: ${materialized.path} (consider gitignoring .claude/)`);
    });
    cmd
        .command('verify')
        .description('Judge the feedback state by diffing current failures against the session baseline (exit 0 clean, exit 1 new failures)')
        .option('--json', 'Output the judgment as JSON')
        .option('--session <id>', 'Session whose baseline to read (defaults to OMC_SESSION_ID, then a sole baseline under the state root)')
        .option('--write-baseline', 'Record the current failures as the session baseline instead of judging')
        .addHelpText('after', `
Examples:
  $ omc ralph verify --write-baseline     Record the baseline (Step 1f, first iteration)
  $ omc ralph verify                      Gate: exit 1 only when NEW failures appeared
  $ omc ralph verify --json               Machine-readable judgment
  $ omc ralph verify --session <id>       Judge another session's baseline
  Feedback commands come from the PRD's feedbackCommands, falling back to
  package.json build/lint/test scripts. Inside an \`omc ralph afk\` session only
  the launcher's declared --verify commands run. A missing baseline is not a failure:
  verify reports the current signatures as a baseline candidate and exits 0.`)
        .action((options) => {
        process.exitCode = ralphVerify(options);
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
        .action((options) => {
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
            if (options.json)
                console.log(JSON.stringify(plan, null, 2));
            else
                console.log(renderMapPlan(plan));
            return;
        }
        const sessionId = options.session ?? randomUUID();
        if (options.launch) {
            // claude rejects a non-UUID --session-id and dies silently (stdio is
            // ignored on the spawn path) — validate before claiming anything.
            try {
                validateSessionId(sessionId);
            }
            catch {
                console.error(`omc ralph from-map --launch: --session must be a UUID (got "${sessionId}")`);
                process.exitCode = 1;
                return;
            }
        }
        const outcomes = executePlanActions(plan, {
            provenance: { sessionId, mode: 'hitl', at: new Date().toISOString() },
        });
        const report = (extra) => {
            if (options.json)
                console.log(JSON.stringify({ plan, outcomes, ...(extra ? { note: extra } : {}) }, null, 2));
            else {
                console.log(renderMapPlan(plan));
                console.log(renderActionOutcomes(outcomes));
                if (extra)
                    console.log(extra);
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
        const feedbackCommands = resolveFeedbackCommands(process.cwd());
        const composed = composeMapPrd(process.cwd(), sessionId, plan, records, { feedbackCommands });
        if (!composed.written) {
            report(`launch refused — PRD not composed: ${composed.error ?? 'unknown'}`);
            process.exitCode = 1;
            return;
        }
        process.env.OMC_SESSION_ID = sessionId;
        const argv = ralphAfkArgv(mapRunTaskPrompt(plan, composed.stories), [], sessionId);
        const child = defaultSpawnFn('claude', argv, { cwd: process.cwd() });
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
    return cmd;
}
/**
 * Feedback commands for judgment. Inside an `omc ralph afk` session only the
 * launcher-declared list counts; otherwise the PRD's declared list, else
 * package-script detection.
 */
export function resolveFeedbackCommands(directory, sessionId) {
    const afk = process.env[RALPH_AFK_FEEDBACK_ENV];
    if (afk !== undefined) {
        try {
            const parsed = JSON.parse(afk);
            return Array.isArray(parsed) ? afkFeedbackCommands(parsed.filter((c) => typeof c === 'string')) : [];
        }
        catch {
            return [];
        }
    }
    const declared = readPrd(directory, sessionId)?.feedbackCommands;
    if (declared && declared.length > 0)
        return [...declared];
    try {
        const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        const scripts = pkg.scripts ?? {};
        // Script NAMES are not commands — `test` is not an executable; the
        // detected entries must be runnable invocations.
        return ['build', 'typecheck', 'lint', 'test', 'test:run']
            .filter((name) => typeof scripts[name] === 'string')
            .map((name) => `npm run ${name}`);
    }
    catch {
        return [];
    }
}
const UNRUNNABLE_PATTERN = /not recognized as an internal or external command|command not found|no such file or directory/i;
/** Run one feedback command on the current tree and fingerprint its failures. */
export function runFeedbackCommand(command, directory) {
    try {
        const result = spawnSync(command, {
            shell: true,
            cwd: directory,
            encoding: 'utf8',
            timeout: 600_000,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
        });
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const unrunnable = Boolean(result.error) || (result.status !== 0 && UNRUNNABLE_PATTERN.test(output));
        return { signatures: unrunnable ? [] : signatureLines(output), ...(unrunnable ? { unrunnable: true } : {}) };
    }
    catch {
        return { signatures: [], unrunnable: true };
    }
}
/** The verify action, extracted so tests can drive it directly. Exit code is the contract. */
export function ralphVerify(options, directory = process.cwd(), now = new Date()) {
    const stateRoot = getOmcRoot(directory);
    let sessionId = options.session ?? process.env.OMC_SESSION_ID ?? '';
    if (sessionId) {
        try {
            validateSessionId(sessionId);
        }
        catch (error) {
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
            if (candidates.length === 1)
                sessionId = candidates[0];
            else if (candidates.length > 1) {
                console.error(`omc ralph verify: ${candidates.length} baselines found under ${sessionsRoot} — pass --session <id>`);
                return 1;
            }
        }
        catch {
            // no baselines yet
        }
    }
    const path = sessionId ? baselinePath(stateRoot, sessionId) : '';
    const commands = resolveFeedbackCommands(directory, sessionId || undefined);
    if (commands.length === 0) {
        const message = 'no feedback commands: declare feedbackCommands in the PRD or add package.json build/lint/test scripts';
        if (options.json)
            console.log(JSON.stringify({ sessionId: sessionId || null, baselinePresent: false, commands: [], newFailures: [], resolvedFailures: [], note: message }));
        else
            console.log(`ralph verify: ${message}`);
        return 0;
    }
    const current = {};
    for (const command of commands)
        current[command] = runFeedbackCommand(command, directory);
    if (options.writeBaseline) {
        const written = path ? writeBaseline(path, current, now) : false;
        const note = written ? `baseline recorded at ${path}` : 'could not write a baseline (no session id; pass --session)';
        if (options.json)
            console.log(JSON.stringify({ sessionId: sessionId || null, baselineWritten: written, commands, signatures: Object.fromEntries(Object.entries(current).map(([c, e]) => [c, e.signatures.length])) }));
        else
            console.log(`ralph verify: ${note}`);
        return written ? 0 : 1;
    }
    const baseline = path ? readBaseline(path) : null;
    const diff = diffAgainstBaseline(baseline, current);
    if (options.json) {
        console.log(JSON.stringify({ sessionId: sessionId || null, baselinePresent: Boolean(baseline), commands, newFailures: diff.newSignatures, resolvedFailures: diff.resolvedSignatures }));
        return diff.newSignatures.length > 0 ? 1 : 0;
    }
    if (!baseline) {
        console.log(`ralph verify: no baseline for session ${sessionId || '(unknown)'} — current failures can serve as the baseline; run with --write-baseline at startup`);
        for (const signature of diff.newSignatures)
            console.log(`  candidate: ${signature}`);
        return 0;
    }
    if (diff.newSignatures.length > 0) {
        console.log(`ralph verify: ${diff.newSignatures.length} NEW failure(s) since baseline`);
        for (const signature of diff.newSignatures)
            console.log(`  new: ${signature}`);
        return 1;
    }
    const note = diff.resolvedSignatures.length > 0 ? ` (${diff.resolvedSignatures.length} baseline failure(s) resolved)` : '';
    console.log(`ralph verify: clean vs baseline${note}`);
    return 0;
}
//# sourceMappingURL=ralph.js.map