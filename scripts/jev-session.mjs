#!/usr/bin/env node
// Launcher of background Claude Code sessions with the model and effort chosen by Jev (opt-in by use: nothing runs unless it is called).
//   node scripts/jev-session.mjs --role coordinator|worker --brief <file> --name "<name>" [--coordinator <id>] [--cwd <dir>]
//        [--mode shadow|active|off] [--starter <command>] [--prompt <text>] [--dry-run] [--no-advisor]
//   resume: jev-session --resume <sessionId> --prompt "<text>" --cwd <dir> [--name "<name>"] [--starter <cmd>] [--dry-run] [--no-advisor]
//     the same path as a regular start (start dir and trust, the session pool ceiling, the starter, a row in sessions.jsonl),
//     but without the Jev decision and without the role settings file: the role and the model stay from the original start, no --model/--effort in argv;
//     --role/--brief/--mode/--coordinator are refused with exit code 2 at a resume.
// --no-advisor (a regular start and a resume) turns off the advisor tool of the session: CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 goes into the `env` block of the
// --settings file (a regular start adds it next to the role variables; a resume writes a separate file with only this variable and adds --settings <file>
// to the starter argv, before the prompt). Without the flag nothing changes. A row has `advisor: "disabled"` with the flag (`"settings-error"` when the
// file could not be written). With OMC_JEV_SESSION_PROVIDER=1 every row also has `provider`: the profile name in OMC_PROVIDER, or `claude` without it.
// What it does: reads the brief, asks Jev the same model-routing questions the Agent hook asks (scripts/lib/jev-routing.mjs: the `use` marker of the
// first brief line, the answers read by decideRoutingFromAnswers, the effort cap OMC_JEV_MAX_EFFORT; Jev never picks fable), and starts the session with
// `<starter> --bg --name <name> [--model <m> --effort <e>] --settings <file> "<prompt>"` (starter: --starter, OMC_JEV_SESSION_STARTER, else `claude`).
// The role reaches the session through the `env` block of that --settings file (OMC_SESSION_ROLE, OMC_SESSION_COORDINATOR, OMC_SESSION_NAME): a variable
// exported by the launching process does NOT reach a background session (the daemon keeps its own environment).
// Mode: shadow (default) asks Jev, logs the decision and starts WITHOUT Jev's --model and --effort (the session gets the user's default); active passes
// them. The `use` marker of the first brief line is the user's own choice, not Jev's: it is passed in EVERY mode (also off, also when Jev fails), as in the
// Agent hook where the marker works without Jev; `fable` is refused for a launched session. A global OMC_JEV=off turns the launcher off for good (no query),
// whatever --mode says. When claude refuses the flags of a start, the start is repeated once without them (row: fallback true). Source of the mode: --mode,
// OMC_JEV_SESSION_MODE, the entry `session-routing[:shadow|:active|:off]` of OMC_JEV (the point is named-only: `all` never enables it);
// `off` starts without any query. Jev failing (no key, error, timeout, no usable answer) never stops the start: the session starts with the default
// model and the log row says `degraded`. The text sent to Jev and the paths of the log row are masked here, by maskJevState below (the resolver does not mask them).
// The log: <Jev log directory>/sessions.jsonl, one row per start (the directory of the other Jev logs: OMC_JEV_LOG_DIR, else state/jev under the state
// root of the working directory); the query itself is in shadow.jsonl (point session-routing).
// The session pool (OMC_JEV_POOL=1, OMC_JEV_POOL_MAX_SESSIONS, scripts/lib/jev-pool.mjs): at the ceiling the start is refused; off by default.
// The ceiling covers the launches in flight: a launch takes a reservation under the pool lock before the Jev query and gives it back when it is
// over, so two launchers that counted the sessions at the same time do not both start.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { maskSecrets } from './lib/jev-mask.mjs';
import { capEffort, decideRoutingFromAnswers, getModelRoutingQuestions, parseUseMarker, resolveMaxEffort, ROUTING_TIERS } from './lib/jev-routing.mjs';
import { recordJevShadow, setJevHookContext } from './lib/jev-shadow.mjs';
import { resolveJevLogDir, resolveJevLogMaxBytes, rotateJevLog } from './jev-resolve.mjs';
import { countSessions, poolEnabled, releaseSession, reserveSession, sessionLimit } from './lib/jev-pool.mjs';

const POINT = 'session-routing';
const ROLES = ['coordinator', 'worker'];
const BRIEF_MAX_BYTES = 400_000;
const MODES = ['shadow', 'active', 'off'];

// The text sent to Jev (the start of the brief, the name) and the paths of the log row pass through the secret mask of
// the Jev log (lib/jev-mask.mjs): every string field of the object is masked, other values stay as they are.
const maskJevState = (state) => Object.fromEntries(Object.entries(state).map(([key, value]) => [key, typeof value === 'string' ? maskSecrets(value) : value]));

function parseArgs(argv) {
  const out = { dryRun: false, noAdvisor: false };
  const flags = { '--role': 'role', '--brief': 'brief', '--name': 'name', '--coordinator': 'coordinator', '--cwd': 'cwd', '--mode': 'mode', '--starter': 'starter', '--prompt': 'prompt', '--resume': 'resume' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-advisor') out.noAdvisor = true; // no value, like --dry-run
    else if (Object.hasOwn(flags, a)) {
      if (argv[i + 1] === undefined) return { error: `${a} needs a value` };
      if ((a === '--name' || a === '--prompt' || a === '--resume') && argv[i + 1].startsWith('-')) return { error: `${a}: the value must not start with "-" (claude would read it as a flag)` };
      out[flags[a]] = argv[++i];
    } else return { error: `unknown argument ${a}` };
  }
  return out;
}

// The mode of the point from OMC_JEV: undefined when the point is not named (the default is then shadow), else shadow, active or off.
export function namedLauncherMode(env = process.env) {
  let mode;
  for (const entry of String(env.OMC_JEV || '').split(',')) {
    const token = entry.trim();
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    if (name !== POINT) continue;
    const suffix = colon === -1 ? '' : token.slice(colon + 1);
    mode = suffix === 'active' ? 'active' : suffix === 'off' ? 'off' : 'shadow';
  }
  return mode;
}

export function resolveLauncherMode({ mode: modeArg }, env = process.env) {
  if (String(env.OMC_JEV || '').trim() === 'off') return 'off'; // the global switch (as parseJevEnv); --mode does not break it
  const wanted = modeArg || env.OMC_JEV_SESSION_MODE || namedLauncherMode(env) || 'shadow';
  return MODES.includes(wanted) ? wanted : 'shadow'; // a bad value never turns active on
}

// Default start directory: --cwd, then CLAUDE_PROJECT_DIR, then the working directory of the process CLAUDE_PID (Linux: /proc/<pid>/cwd; other systems skip it), then process.cwd().
// Claude Code does not export CLAUDE_PROJECT_DIR to the Bash tool, but exports CLAUDE_PID: the launcher called from a session inherits that session's project, not whatever `cd` the caller made.
export function resolveStartDir({ cwdArg, env = process.env, platform = process.platform } = {}) {
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (cwdArg) return { dir: resolve(cwdArg), source: 'argument' };
  if (env.CLAUDE_PROJECT_DIR && isDir(env.CLAUDE_PROJECT_DIR)) return { dir: resolve(env.CLAUDE_PROJECT_DIR), source: 'CLAUDE_PROJECT_DIR' };
  if (platform === 'linux' && /^[1-9][0-9]*$/.test(String(env.CLAUDE_PID || ''))) {
    try {
      const target = readlinkSync(`/proc/${env.CLAUDE_PID}/cwd`);
      if (!target.endsWith(' (deleted)') && isDir(target)) return { dir: resolve(target), source: 'CLAUDE_PID' };
    } catch { /* no such process, no access, or not Linux procfs: next link of the chain */ }
  }
  return { dir: resolve(process.cwd()), source: 'process' };
}

// Trust check before the start. Source of the rule: the Claude Code binary, the trust predicate and its helpers:
//   the trust is the flag projects[<path>].hasTrustDialogAccepted of the global config <CLAUDE_CONFIG_DIR or home>/.claude.json; <path> is the repository root of the directory (else the directory);
//   when there is no exact hit the ancestors are walked (inside a repository only up to its root; outside one up to /), so trust of a parent covers its subdirectories;
//   CLAUDE_CODE_SANDBOXED means always trusted, CLAUDE_CODE_IGNORE_PERSISTED_TRUST means no persisted flag counts; the trust of the home directory is session-only in the host.
// This check is deliberately more permissive than the host: it answers `untrusted` only when the config file is readable AND neither the directory, nor any ancestor, nor the main repository
// of a linked worktree has the flag. Anything unclear (no or unreadable file, a legacy .config.json, a custom OAuth config, a worktree whose main repository cannot be resolved) answers `unknown` and the start goes on.
export function checkTrust(dir, env = process.env) {
  try {
    if (env.CLAUDE_CODE_SANDBOXED || env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST || env.CLAUDE_CODE_CUSTOM_OAUTH_URL) return { verdict: 'unknown', reason: 'host-env' };
    const configDir = env.CLAUDE_CONFIG_DIR || homedir();
    for (const legacy of [join(configDir, '.config.json'), join(homedir(), '.config.json')]) if (existsSync(legacy) && statSync(legacy).size > 0) return { verdict: 'unknown', reason: 'legacy-config' };
    const configFile = join(configDir, '.claude.json');
    if (!existsSync(configFile)) return { verdict: 'unknown', reason: 'no-config', configFile };
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (!config || typeof config !== 'object' || !config.projects || typeof config.projects !== 'object') return { verdict: 'unknown', reason: 'no-projects', configFile };
    const norm = (p) => String(p).replace(/\\/g, '/');
    const candidates = new Set();
    const forms = new Set([resolve(dir)]);
    try { forms.add(realpathSync(dir)); } catch { /* the form without symlinks is only an addition */ }
    for (const form of forms) {
      for (let current = form; ; current = dirname(current)) {
        candidates.add(norm(current));
        const gitEntry = join(current, '.git');
        let gitStat = null;
        try { gitStat = lstatSync(gitEntry); } catch { /* no .git here */ }
        if (gitStat && gitStat.isFile()) { // a linked worktree (or a submodule): the trust key may be the main repository, which is not an ancestor
          const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitEntry, 'utf8'))?.[1]?.trim();
          if (!gitdir) return { verdict: 'unknown', reason: 'worktree-unresolved', configFile };
          const gitdirAbs = resolve(current, gitdir);
          const common = resolve(gitdirAbs, readFileSync(join(gitdirAbs, 'commondir'), 'utf8').trim());
          candidates.add(norm(dirname(common)));
        }
        if (dirname(current) === current) break;
      }
    }
    const trustedAt = [...candidates].find((p) => config.projects[p]?.hasTrustDialogAccepted);
    return trustedAt ? { verdict: 'trusted', trustedAt, configFile } : { verdict: 'untrusted', configFile };
  } catch (error) {
    return { verdict: 'unknown', reason: `error: ${String(error?.message || error).slice(0, 80)}` };
  }
}

function writeRow(logDir, row, env) { // a failing log never stops the start
  try {
    mkdirSync(logDir, { recursive: true });
    rotateJevLog(join(logDir, 'sessions.jsonl'), resolveJevLogMaxBytes(env));
    appendFileSync(join(logDir, 'sessions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), point: POINT, ...row }) + '\n', 'utf8');
  } catch { /* no log, the session still starts */ }
}

// The decision of the launcher, without any side effect except the Jev query (injectable for tests): marker, Jev answers, cap.
// Returns { model, effort, source: {model, effort}, score, confidence, marker, refused, degraded, reason, asked }.
export function decideSession({ brief, name, role, ask = recordJevShadow, env = process.env, noQuery = false }) {
  const cap = resolveMaxEffort(env);
  const marker = parseUseMarker(brief);
  const refused = [];
  if (marker.refused) refused.push(marker.refused);
  let markerModel = marker.model;
  if (markerModel && !ROUTING_TIERS.includes(markerModel)) { refused.push(`${markerModel}-not-for-sessions`); markerModel = undefined; } // no fable for a launched session
  const markerEffort = marker.effort;
  const result = { model: markerModel, effort: markerEffort ? capEffort(markerEffort, cap) : undefined, source: { model: markerModel ? 'marker' : undefined, effort: markerEffort ? 'marker' : undefined }, marker: marker.active ? marker.line : undefined, refused: refused.length ? refused.join(',') : undefined, degraded: false, asked: false };
  if (markerEffort && capEffort(markerEffort, cap) !== markerEffort) result.capped = { requested: markerEffort };
  if (noQuery || (markerModel && markerEffort)) return result; // both pinned (as in the Agent hook) or mode off: Jev is not asked
  const allQuestions = getModelRoutingQuestions(env);
  const questions = markerModel ? { effort: allQuestions.effort } : allQuestions;
  result.asked = true;
  let answered;
  try {
    answered = ask({ point: POINT, state: maskJevState({ tool_name: 'SessionLauncher', subagent_type: `session-${role}`, task: marker.active ? marker.prompt : brief, description: name }), questions, heuristic: null, permissionMode: undefined });
  } catch (error) {
    result.degraded = true; result.reason = `query-error: ${String(error?.message || error).slice(0, 120)}`; return result;
  }
  const answers = answered && answered.mode === 'active' && answered.answers && typeof answered.answers === 'object' ? answered.answers : undefined;
  if (!answers) {
    result.degraded = true; result.reason = answered ? `no-answers (mode ${answered.mode ?? 'unknown'}${answered.skipped ? `, skipped ${answered.skipped}` : ''})` : 'no-result'; return result;
  }
  const decided = decideRoutingFromAnswers(answers, { maxEffort: cap });
  if (!markerModel && decided.model) { result.model = decided.model; result.source.model = 'jev'; }
  if (!markerEffort && decided.effort !== undefined) { result.effort = decided.effort; result.source.effort = 'jev'; }
  result.score = decided.score; result.confidence = decided.confidence;
  if (result.model === undefined && result.effort === undefined) { result.degraded = true; result.reason = 'no-usable-answer'; }
  return result;
}

function settingsPathFor({ logDir, name }) { // a durable directory: `env` of a settings file is read live, a deleted file could take the role away mid-session
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
  return join(logDir, 'session-settings', `${slug}-${Date.now()}-${randomUUID().slice(0, 8)}.json`); // a unique name, two starts of one name in one millisecond never share a file
}
function writeSettings(path, { name, role, coordinator, noAdvisor }) { // a resume calls with noAdvisor only; JSON.stringify leaves out undefined keys
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const sessionEnv = { OMC_SESSION_ROLE: role, OMC_SESSION_NAME: name, ...(coordinator ? { OMC_SESSION_COORDINATOR: coordinator } : {}), ...(noAdvisor ? { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } : {}) };
  writeFileSync(path, JSON.stringify({ env: sessionEnv }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); // never overwrites a file of another session
  return path;
}

const quote = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
// OMC_JEV_SESSION_PROVIDER=1 adds the provider to every row: the profile name of the OMC_PROVIDER marker the launcher runs with (and passes to the
// starter), `claude` without it. Without the switch the rows have no such field.
const providerField = (env) => (String(env?.OMC_JEV_SESSION_PROVIDER ?? '').trim() === '1' ? { provider: String(env.OMC_PROVIDER ?? '').trim() || 'claude' } : {});
const describe = (decision) => (decision.degraded ? `degraded (${decision.reason})` : `model ${decision.model ?? '-'}, effort ${decision.effort ?? '-'}`);

// The session pool gate: off unless OMC_JEV_POOL=1; at a ceiling above 0 (OMC_JEV_POOL_MAX_SESSIONS) the start is refused. A counter
// read error never refuses and shows in the row as pool {sessions: null, error}. The count is the running sessions of the counter command
// plus the launches in flight (reservations of other launchers, see reserveSession); an admitted launch holds a reservation of its own,
// which `held` collects and main gives back when the launch is over. A reservation that cannot be taken in time (the pool lock) admits the
// launch, as a counter read error does.
function poolGate(env, logDir, held) {
  if (!poolEnabled(env)) return { refuse: false };
  const limit = sessionLimit(env);
  const counted = countSessions({ env });
  if (counted.error) return { refuse: false, pool: { sessions: null, error: counted.error }, sessions: null, limit };
  let reservation = { ok: true, file: null, inFlight: 0 };
  try { reservation = reserveSession({ dir: logDir, counted: counted.sessions, limit, env }); } catch { /* the reservation is advisory: a file error admits the launch */ }
  if (reservation.ok && reservation.file) held.push(() => releaseSession(logDir, reservation.file));
  const sessions = counted.sessions + reservation.inFlight;
  return { refuse: !reservation.ok, pool: { sessions: counted.sessions, ...(reservation.inFlight ? { starting: reservation.inFlight } : {}), limit }, sessions, limit };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const held = []; // the reservations of this launch (the session pool), given back whatever way the launch ends
  try {
    return await launch(argv, env, held);
  } finally {
    for (const release of held) release();
  }
}

async function launch(argv, env, held) {
  const args = parseArgs(argv);
  const usage = 'Usage: jev-session --role coordinator|worker --brief <file> --name "<name>" [--coordinator <id>] [--cwd <dir>] [--mode shadow|active|off] [--starter <command>] [--prompt <text>] [--dry-run] [--no-advisor] | resume: jev-session --resume <sessionId> --prompt "<text>" --cwd <dir> [--name "<name>"] [--starter <command>] [--dry-run] [--no-advisor]';
  let advisorField = args.noAdvisor ? { advisor: 'disabled' } : {}; // without the flag the rows have no new field; a failed settings write changes it to settings-error
  if (args.error) { console.error(`jev-session: ${args.error}\n${usage}`); return 2; }

  const logDir = await resolveJevLogDir(env);
  const refusalMessage = (gate) => `jev-session: refused: the session pool is full (${gate.sessions}/${gate.limit}). No session was started; a slot frees up when a running session ends. Do not delegate further: do the work yourself with the tools you have.`;

  // Resume of a background session (--resume): the same path as a regular start (start dir and trust, the pool gate, the starter, a row
  // in sessions.jsonl), but without the Jev decision and without the role settings file: the role and the model stay from the original
  // start of the session, there is no --model or --effort in argv. Options that make no sense at a resume (--role, --brief, --mode,
  // --coordinator) are refused with exit code 2.
  if (args.resume) {
    const usageResume = 'Usage of resume: jev-session --resume <sessionId> --prompt "<text>" --cwd <dir> [--name "<name>"] [--starter <command>] [--dry-run] [--no-advisor]';
    for (const [flag, value] of [['--role', args.role], ['--brief', args.brief], ['--mode', args.mode], ['--coordinator', args.coordinator]]) {
      if (value !== undefined) { console.error(`jev-session: --resume: ${flag} makes no sense at a resume (the role and the Jev decision stay from the original start of the session)\n${usageResume}`); return 2; }
    }
    if (!args.prompt) { console.error(`jev-session: --resume needs --prompt (the text of the resume turn)\n${usageResume}`); return 2; }
    const name = args.name || `resume-${String(args.resume).slice(0, 8)}`;
    const { dir: cwd, source: cwdSource } = resolveStartDir({ cwdArg: args.cwd, env });
    if (!existsSync(cwd)) { console.error(`jev-session: directory ${cwd} does not exist`); return 2; }
    const trust = checkTrust(cwd, env);
    if (trust.verdict === 'untrusted') { console.error(`jev-session: directory ${cwd} (source: ${cwdSource}) is not trusted by Claude Code (no trust in ${trust.configFile} for it, its parent directories or its repository); a background session would not start. Pass --cwd <a trusted project directory> or run \`claude\` once in this directory and accept the trust. Nothing was started.`); return 2; }

    // The pool gate, the same as at a regular start.
    const gate = poolGate(env, logDir, held);
    if (gate.refuse) {
      const maskedRefusal = maskJevState({ cwd });
      writeRow(logDir, { mode: 'resume', resume: args.resume, name, ...advisorField, ...providerField(env), ...(maskedRefusal.cwd ? { cwd: maskedRefusal.cwd } : {}), cwd_source: cwdSource, result: 'pool-refused', pool: gate.pool }, env);
      console.error(refusalMessage(gate));
      return 2;
    }

    const starter = args.starter || env.OMC_JEV_SESSION_STARTER || 'claude';
    const maskedCwd = maskJevState({ cwd }).cwd;
    const starterArgv = ['--bg', '--resume', String(args.resume), args.prompt]; // no --model/--effort; --settings only with --no-advisor
    if (args.noAdvisor) { // a resume with --no-advisor gets a settings file of its own (the env of the launching process does not reach a background session)
      let resumeSettings = settingsPathFor({ logDir, name }); // the same directory as the role file of a regular start
      if (!args.dryRun) { // a dry run writes nothing
        try { writeSettings(resumeSettings, { noAdvisor: true }); } catch (error) { resumeSettings = null; advisorField = { advisor: 'settings-error' }; console.error(`jev-session: warning: the settings file that disables the advisor was not created (${error.message}); the resume starts without --settings`); }
      }
      if (resumeSettings) starterArgv.splice(3, 0, '--settings', resumeSettings); // the prompt stays last
    }
    if (args.dryRun) {
      writeRow(logDir, { mode: 'resume', resume: args.resume, name, ...advisorField, ...providerField(env), ...(maskedCwd ? { cwd: maskedCwd } : {}), cwd_source: cwdSource, result: 'dry-run', ...(gate.pool ? { pool: gate.pool } : {}) }, env);
      console.log(`jev-session (dry run): resume ${args.resume}, directory ${cwd} (${cwdSource})\ncommand: ${starter} ${starterArgv.map(quote).join(' ')}`);
      return 0;
    }
    const startedAt = Date.now();
    const started = spawnSync(starter, starterArgv, { cwd, encoding: 'utf8', timeout: 120_000, env });
    const output = `${started.stdout || ''}${started.stderr || ''}`;
    const id = /backgrounded\s*[·.]\s*([0-9a-f]{6,})\b/i.exec(output)?.[1] ?? null;
    writeRow(logDir, { mode: 'resume', resume: args.resume, name, ...advisorField, ...providerField(env), ...(maskedCwd ? { cwd: maskedCwd } : {}), cwd_source: cwdSource, result: 'resume', ...(gate.pool ? { pool: gate.pool } : {}), started_with: { model: null, effort: null }, queryMs: 0, session_id: id, starter_exit: started.status ?? (started.error ? `error:${started.error.code || started.error.message}` : null), totalMs: Date.now() - startedAt }, env);
    if (started.error || started.status !== 0) {
      if (/not trusted/i.test(output)) console.error(`jev-session: directory ${cwd} (source: ${cwdSource}) is not trusted by Claude Code: run \`claude\` once in this directory, accept the trust and repeat.`);
      process.stderr.write(output);
      console.error(`jev-session: resume of ${args.resume} failed (${started.error ? started.error.message : `exit ${started.status}`})`);
      return started.status || 1;
    }
    process.stdout.write(output);
    console.error(`jev-session: ${id ?? '?'} resume of ${args.resume} directory=${cwd} (${cwdSource}); started with the model and effort of the original (no Jev decision)`);
    return 0;
  }

  if (!ROLES.includes(args.role) || !args.brief || !args.name) { console.error(`jev-session: --role (${ROLES.join('|')}), --brief and --name are required\n${usage}`); return 2; }
  if (args.mode && !MODES.includes(args.mode)) { console.error(`jev-session: --mode ${args.mode}: allowed ${MODES.join(', ')}\n${usage}`); return 2; }
  const briefPath = resolve(args.brief);
  let brief;
  try {
    if (statSync(briefPath).size > BRIEF_MAX_BYTES) throw new Error(`the file is larger than ${BRIEF_MAX_BYTES} bytes`);
    brief = readFileSync(briefPath, 'utf8');
  } catch (error) { console.error(`jev-session: brief ${briefPath}: ${error.message}`); return 2; }
  const { dir: cwd, source: cwdSource } = resolveStartDir({ cwdArg: args.cwd, env });
  if (!existsSync(cwd)) { console.error(`jev-session: directory ${cwd} does not exist`); return 2; }
  const trust = checkTrust(cwd, env);
  if (trust.verdict === 'untrusted') { console.error(`jev-session: directory ${cwd} (source: ${cwdSource}) is not trusted by Claude Code (no trust in ${trust.configFile} for it, its parent directories or its repository); a background session would not start. Pass --cwd <a trusted project directory> or run \`claude\` once in this directory and accept the trust. Nothing was started.`); return 2; }

  // The session pool gate before any Jev query: at the ceiling the start is refused with the count in the message and in the log row; a counter
  // read error never refuses and shows in the final row as pool {sessions: null, error}.
  const gate = poolGate(env, logDir, held);
  if (gate.refuse) {
    const maskedRefusal = maskJevState({ brief: briefPath, cwd }); // the same mask as the regular row
    writeRow(logDir, { role: args.role, name: args.name, ...advisorField, ...providerField(env), ...(args.coordinator ? { coordinator: args.coordinator } : {}), brief: maskedRefusal.brief, cwd: maskedRefusal.cwd, cwd_source: cwdSource, result: 'pool-refused', pool: gate.pool }, env);
    console.error(refusalMessage(gate));
    return 2;
  }

  const starter = args.starter || env.OMC_JEV_SESSION_STARTER || 'claude';
  const mode = resolveLauncherMode(args, env);
  const startedAt = Date.now();

  let decision;
  if (mode === 'off') decision = decideSession({ brief, name: args.name, role: args.role, env, noQuery: true }); // no query; the marker (the user's own choice) is still read
  else {
    // The query is a synchronous one: recordJevShadow asks Jev (and logs the row in shadow.jsonl) in active mode only; the launcher's own mode (shadow or active)
    // decides below whether the answer is passed to the session. OMC_JEV is set for this process only.
    const previous = process.env.OMC_JEV;
    process.env.OMC_JEV = `${POINT}:active`;
    try {
      await setJevHookContext({ session_id: env.CLAUDE_CODE_SESSION_ID, cwd, agent_type: 'jev-session' });
      decision = decideSession({ brief, name: args.name, role: args.role, env });
    } catch (error) { decision = { degraded: true, asked: false, source: {}, reason: `error: ${String(error?.message || error).slice(0, 120)}` }; }
    finally { if (previous === undefined) delete process.env.OMC_JEV; else process.env.OMC_JEV = previous; }
  }
  const queryMs = Date.now() - startedAt;

  // What goes to the start: a value of the `use` marker always (the user's choice, also when Jev fails or the mode is shadow or off); a value of Jev only
  // in active mode with a usable answer. Anything else leaves the session its default.
  const jevPasses = mode === 'active' && !decision.degraded;
  const passModel = decision.model && (decision.source?.model === 'marker' || (jevPasses && decision.source?.model === 'jev')) ? decision.model : undefined;
  const passEffort = decision.effort && (decision.source?.effort === 'marker' || (jevPasses && decision.source?.effort === 'jev')) ? decision.effort : undefined;
  const settingsFile = settingsPathFor({ logDir, name: args.name });
  const buildArgs = (withFlags, withSettings) => {
    const a = ['--bg', '--name', args.name];
    if (withFlags && passModel) a.push('--model', passModel);
    if (withFlags && passEffort) a.push('--effort', passEffort);
    if (withSettings) a.push('--settings', settingsFile);
    a.push(args.prompt || `Read ${briefPath} and carry it out.`);
    return a;
  };

  // The log row keeps paths only through the state mask, never the text of the brief.
  const masked = maskJevState({ brief: briefPath, cwd });
  const row = { mode, ...advisorField, role: args.role, name: args.name, ...providerField(env), ...(args.coordinator ? { coordinator: args.coordinator } : {}), brief: masked.brief, cwd: masked.cwd, cwd_source: cwdSource, result: decision.degraded ? 'degraded' : mode === 'off' ? 'off' : 'decided', ...(decision.reason ? { reason: decision.reason } : {}), ...(decision.marker ? { marker: decision.marker } : {}), ...(decision.refused ? { refused: decision.refused } : {}), ...(decision.capped ? { capped: decision.capped } : {}), ...(decision.model ? { model: { to: decision.model, source: decision.source.model } } : {}), ...(decision.effort ? { effort: { to: decision.effort, source: decision.source.effort, ...(decision.score !== undefined ? { score: decision.score, confidence: decision.confidence } : {}) } } : {}), ...(gate.pool ? { pool: gate.pool } : {}), started_with: { model: passModel ?? null, effort: passEffort ?? null }, queryMs };

  if (args.dryRun) { // a dry run writes no settings file; it prints the one it would write
    writeRow(logDir, { ...row, result: 'dry-run' }, env);
    console.log(`jev-session (dry run): mode ${mode}, decision ${describe(decision)}\ncommand: ${starter} ${buildArgs(true, true).map(quote).join(' ')}\n(the role settings file would be created in ${settingsFile}${args.noAdvisor ? ', with CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1' : ''})`);
    return 0;
  }
  let withSettings = true;
  try { writeSettings(settingsFile, { name: args.name, role: args.role, coordinator: args.coordinator, noAdvisor: args.noAdvisor }); } catch (error) { withSettings = false; if (args.noAdvisor) row.advisor = 'settings-error'; console.error(`jev-session: warning: the role settings file was not created (${error.message}); the session starts without a role`); }
  let started = spawnSync(starter, buildArgs(true, withSettings), { cwd, encoding: 'utf8', timeout: 120_000, env });
  let output = `${started.stdout || ''}${started.stderr || ''}`;
  let fallback = false;
  // claude may refuse the flags of Jev's choice (a model and effort pair it does not accept): the start is repeated once without them, never lost.
  if ((started.error || started.status !== 0) && (passModel || passEffort) && !/not trusted/i.test(output)) {
    fallback = true;
    started = spawnSync(starter, buildArgs(false, withSettings), { cwd, encoding: 'utf8', timeout: 120_000, env });
    output = `${started.stdout || ''}${started.stderr || ''}`;
  }
  const id = /backgrounded\s*[·.]\s*([0-9a-f]{6,})\b/i.exec(output)?.[1];
  writeRow(logDir, { ...row, ...(fallback ? { fallback: true, started_with: { model: null, effort: null } } : {}), session_id: id ?? null, starter_exit: started.status ?? (started.error ? `error:${started.error.code || started.error.message}` : null), totalMs: Date.now() - startedAt }, env);
  if (started.error || started.status !== 0) {
    if (/not trusted/i.test(output)) console.error(`jev-session: directory ${cwd} (source: ${cwdSource}) is not trusted by Claude Code: run \`claude\` once in this directory, accept the trust and repeat.`);
    process.stderr.write(output);
    console.error(`jev-session: the session start failed (${started.error ? started.error.message : `exit ${started.status}`}); Jev decision: ${describe(decision)}`);
    return started.status || 1;
  }
  process.stdout.write(output);
  console.error(`jev-session: ${id ?? '?'} ${args.name} role=${args.role} mode=${mode} directory=${cwd} (${cwdSource}) Jev: ${describe(decision)}; started with ${fallback ? 'the default model and effort (claude refused the flags, repeated without them)' : `model ${passModel ?? 'default'}, effort ${passEffort ?? 'default'}`}`);
  return 0;
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })(); // also through a symlink (a wrapper on PATH), never for an importing test
if (isMain) process.exit(await main());
