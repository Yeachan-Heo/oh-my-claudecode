// Session handoff at a large transcript (opt-in: OMC_JEV_HANDOFF=1). All the logic lives here, with the input of the
// hook as a parameter (testable without the hook); scripts/pre-tool-enforcer.mjs only calls it. A main session gets a
// warning from OMC_JEV_HANDOFF_WARN_MIB (default 20 MiB), attached to the calls that pass. With an active ultragoal and a
// transcript over 25 MiB (the limit the /goal guard reads: MAX_TRANSCRIPT_BYTES in the hook) only the handoff tools pass
// (Write/Edit on the handoff file, Read/Grep/Glob, ToolSearch/ListAgents/SendMessage, Bash with one command of the session
// launcher), and after the takeover line in the handoff file every tool is refused. Subagents (input with agent_id) pass at
// a transcript over the limit, with a journal row. Rows go to denials.jsonl (kind "handoff") through the denial counter's writer.
//
// Configuration (all optional):
//   OMC_JEV_HANDOFF_FILE      base name of the handoff file (default HANDOFF.md)
//   OMC_JEV_HANDOFF_MARKER    the takeover line the successor appends: "<marker> <successor name> <ISO time>" (default "TAKEN OVER:")
//   OMC_JEV_HANDOFF_COMMAND   the launcher command allowed in handoff mode and printed in the steps (default jev-session);
//                             the first word of a Bash command must be this name or a path that ends with it, so it is
//                             a wrapper on PATH that runs scripts/jev-session.mjs
//   OMC_JEV_HANDOFF_WARN_MIB  warning threshold in MiB (default 20); OMC_JEV_HANDOFF_STEP_MIB: the growth between warnings (default 1)
import { createHash } from 'crypto';
import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { denialLogDir, writeDenialRow } from './jev-denial-counter.mjs';
import { parseUseMarker, USE_MARKER_EFFORTS } from './jev-routing.mjs';
import { sessionRoleFacts } from './jev-delegation.mjs';

const MIB = 1024 * 1024;
const DEFAULT_WARN_MIB = 20;
const DEFAULT_STEP_MIB = 1;
export const HANDOFF_BLOCK_BYTES = 25 * MIB; // = MAX_TRANSCRIPT_BYTES in pre-tool-enforcer.mjs; the hook flags an overflow at exactly this size
export const DEFAULT_HANDOFF_FILE = 'HANDOFF.md';
export const DEFAULT_TAKEOVER_MARKER = 'TAKEN OVER:';
export const DEFAULT_LAUNCHER_COMMAND = 'jev-session';

function positiveMib(env, name, fallback) {
  const raw = String(env?.[name] ?? '').trim();
  return /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : fallback;
}

export const handoffWarnBytes = (env = process.env) => positiveMib(env, 'OMC_JEV_HANDOFF_WARN_MIB', DEFAULT_WARN_MIB) * MIB;
export const handoffStepBytes = (env = process.env) => positiveMib(env, 'OMC_JEV_HANDOFF_STEP_MIB', DEFAULT_STEP_MIB) * MIB;

export function handoffFileName(env = process.env) {
  const raw = String(env?.OMC_JEV_HANDOFF_FILE ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : DEFAULT_HANDOFF_FILE;
}

export function takeoverMarker(env = process.env) {
  const raw = String(env?.OMC_JEV_HANDOFF_MARKER ?? '').trim();
  return raw && raw.length <= 40 && !/[\r\n]/.test(raw) ? raw : DEFAULT_TAKEOVER_MARKER;
}

export function launcherCommand(env = process.env) {
  const raw = String(env?.OMC_JEV_HANDOFF_COMMAND ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : DEFAULT_LAUNCHER_COMMAND;
}

const EVENT_RESULTS = { warning: 'passed', 'handoff-allowed': 'passed', 'handoff-subagent': 'passed', 'handoff-refused': 'denied', 'handed-over-refused': 'denied' };

// One handoff row of the denial journal: the common fields of the five events.
function writeHandoffRow(stateDir, env, data, event, sizeBytes) {
  const sid = typeof data.session_id === 'string' ? data.session_id : typeof data.sessionId === 'string' ? data.sessionId : null;
  const agent = data.agent_id || data.agentId || null;
  const toolName = data.tool_name || data.toolName || null;
  const toolUseId = data.tool_use_id || data.toolUseId || null; // the hook payload id, when the hook got one
  const bytes = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : null;
  // A row without a tool_use_id is told apart by event and row time (two different calls of one session must not collide).
  const id = createHash('sha256').update(`handoff\x1f${sid ?? 'no-session'}${agent ? `/${agent}` : ''}\x1f${toolUseId || `${event}#${Date.now()}`}`).digest('hex').slice(0, 16);
  writeDenialRow({ id, kind: 'handoff', guard: 'handoff', action: event, result: EVENT_RESULTS[event] || 'denied', session_id: sid, agent_id: agent, tool_name: toolName, tool_use_id: toolUseId, bytes }, denialLogDir(stateDir, env));
}

// Role, coordinator and name of the session from the env of the launcher; empty when the session has no role.
function sessionFacts(env) {
  return sessionRoleFacts(env) || { role: '', coordinator: '', name: '' };
}

// The base name after normalising the path (backslash to slash) must be exactly the handoff file name.
export function isHandoffFileName(path, env = process.env) {
  return basename(String(path || '').replace(/\\/g, '/')) === handoffFileName(env);
}

// Bash in handoff mode only with one launcher command: the first word is the launcher command or a path that ends with
// /<launcher command>; refused: `;`, `&&`, `||`, `|`, `&`, `$(`, backtick, `>`, `<`, a new line.
export function isLauncherCommand(command, env = process.env) {
  if (typeof command !== 'string') return false;
  const text = command.trim();
  if (!text || /[;&|<>`\n\r]|\$\(/.test(text)) return false;
  const first = text.split(/\s+/)[0];
  const name = launcherCommand(env);
  return first === name || basename(first.replace(/\\/g, '/')) === name;
}

// sha256 of a content (the provenance check of the takeover line).
function hashContent(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex');
}

// The content of the handoff file as predicted after an allowed write of this session: Write gives the whole content of the
// input, Edit gives the content of the file before the write with old_string replaced by new_string (replace_all honoured);
// null when it cannot be computed. The session itself updates the hash in its state at every allowed write, so a takeover
// line in a content that this session did not write with its last write comes from another session.
function predictedContentAfterWrite(toolName, toolInput, path) {
  try {
    if (toolName === 'Write') return String(toolInput?.content ?? '');
    if (toolName === 'Edit') {
      let content = '';
      try { content = readFileSync(path, 'utf8'); } catch { content = ''; }
      const oldString = String(toolInput?.old_string ?? '');
      const newString = String(toolInput?.new_string ?? '');
      return toolInput?.replace_all === true ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    }
    return null;
  } catch { return null; }
}

function hashAfterWrite(toolName, toolInput, path) {
  const content = predictedContentAfterWrite(toolName, toolInput, path);
  return typeof content === 'string' ? hashContent(content) : null;
}

// The takeover line counts only when the session itself registered a write of the handoff file (handoff_hash in the state)
// and the content of the file differs from its last write, that is, the line was appended by another session.
function isHandedOver(state, path, env) {
  try {
    if (!state?.handoff_path || !state.handoff_hash) return false;
    const content = readFileSync(path, 'utf8');
    if (hashContent(content) === state.handoff_hash) return false; // the last write was this session's: not counted
    return readTakeoverLine(path, env).found;
  } catch { return false; }
}

// Registration of a handoff write in the session state (the path and the hash of the predicted content after the write).
function registerHandoffWrite(stateDir, sessionId, state, toolName, toolInput) {
  try {
    const path = resolve(String(toolInput?.file_path ?? toolInput?.path ?? ''));
    const hash = hashAfterWrite(toolName, toolInput, path);
    if (!hash) return state;
    writeHandoffState(stateDir, sessionId, { ...state, handoff_path: path, handoff_hash: hash });
    return readHandoffState(stateDir, sessionId);
  } catch { return state; }
}

// The value of an argument `--name` or `--name=value` of the command (quotes removed).
function argumentValue(command, name) {
  const m = String(command || '').match(new RegExp(`(?:^|\\s)--${name}(?:[ =]\\s*)("([^"]*)"|'([^']*)'|[^\\s]+)`));
  return m ? (m[2] ?? m[3] ?? m[1]).trim() : '';
}

// The tools allowed in handoff mode: (a) Write/Edit on the handoff file, (b) Read/Grep/Glob (reading the brief and notes),
// (c) ToolSearch (SendMessage is a deferred tool), ListAgents, SendMessage, (d) Bash with one launcher command. Everything else: refused.
// Write/Edit only for the handoff file in the working directory of the session (cwd of the hook input) or in the session's
// state directory of .omc, and only for a file that does not exist or was written earlier by this session (the path in the state);
// Bash only with --brief equal to the registered handoff_path, and only one run per handoff (the successor_started flag in the
// state; a second run is refused).
export function handoffModeTools(toolName, toolInput, { cwd = '', sessionStateDir = '', state = null, env = process.env } = {}) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Write' || toolName === 'Edit') {
    const path = String(input.file_path ?? input.path ?? '');
    if (!isHandoffFileName(path, env)) return false;
    const resolved = resolve(path);
    const dir = dirname(resolved);
    const allowedDir = (cwd && dir === resolve(String(cwd))) || (sessionStateDir && dir === resolve(String(sessionStateDir)));
    if (!allowedDir) return false;
    const exists = existsSync(resolved);
    const writtenBySession = Boolean(state?.handoff_path) && resolve(String(state.handoff_path)) === resolved;
    return !exists || writtenBySession;
  }
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return true;
  if (toolName === 'ToolSearch' || toolName === 'ListAgents' || toolName === 'SendMessage') return true;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    if (!isLauncherCommand(input.command ?? '', env)) return false;
    const handoffState = state && typeof state === 'object' ? state : null;
    const brief = argumentValue(input.command ?? '', 'brief');
    if (!handoffState?.handoff_path || !brief) return false;
    if (resolve(brief) !== resolve(String(handoffState.handoff_path))) return false;
    // Allow one launcher attempt: check both successor_started (confirmed) and launcher_attempted (pending confirmation)
    if (handoffState.successor_started === true || handoffState.launcher_attempted === true) return false;
    return true;
  }
  return false;
}

// The model id of the transcript to the alias of the `use` marker (claude-opus-* to opus and so on).
export function modelAlias(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (/^claude-opus/.test(m)) return 'opus';
  if (/^claude-sonnet/.test(m)) return 'sonnet';
  if (/^claude-haiku/.test(m)) return 'haiku';
  if (/^claude-fable/.test(m)) return 'fable';
  return '';
}

function buildUseLine(model, effort) { // the syntax is checked by parseUseMarker (jev-routing.mjs)
  if (!model) return '';
  const line = effort ? `use ${model} ${effort}` : `use ${model}`;
  const marker = parseUseMarker(`${line}\n`);
  return marker.active && marker.model === model && (marker.effort ?? '') === effort ? line : '';
}

// The `use` line of the successor. (i) the row of sessions.jsonl with this session_id (the log in the Jev log directory, a
// row written by jev-session.mjs): started_with.model, and when empty model.to; the effort of started_with.effort, then
// effort.to; unknown or `max` gives a line without the effort (parseUseMarker refuses max). (ii) fallback: the model field of
// the last assistant message at the end of the transcript (the last 256 KiB), the alias through modelAlias. (iii) no model:
// an empty string, and Jev chooses the model and effort of the successor at start.
export function successorUseLine({ sessionId, transcriptPath, stateDir, env = process.env }) {
  let model = '';
  let effort = '';
  try {
    if (typeof sessionId === 'string' && sessionId) {
      const file = join(denialLogDir(stateDir, env), 'sessions.jsonl'); // the same log directory as the launcher's
      if (existsSync(file)) {
        const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        for (let i = rows.length - 1; i >= 0; i--) {
          let row; // the last row of this session (a start or a fallback, both have started_with/model.to)
          try { row = JSON.parse(rows[i]); } catch { continue; }
          if (row?.session_id !== sessionId) continue;
          model = String(row?.started_with?.model || row?.model?.to || '');
          const rawEffort = String(row?.started_with?.effort || row?.effort?.to || '');
          effort = USE_MARKER_EFFORTS.includes(rawEffort) ? rawEffort : '';
          break;
        }
      }
    }
  } catch { /* reading the journal must not stop the hook */ }
  if (!model) {
    try {
      const path = typeof transcriptPath === 'string' && transcriptPath ? transcriptPath : '';
      if (path && lstatSync(path).isFile()) {
        const size = statSync(path).size;
        const from = Math.max(0, size - 256 * 1024);
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(size - from);
          let read = 0;
          while (read < buffer.length) {
            const n = readSync(fd, buffer, read, buffer.length - read, from + read);
            if (n <= 0) break;
            read += n;
          }
          const lines = buffer.toString('utf8', 0, read).split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            let entry; // the model field of the last assistant message at the end of the transcript
            try { entry = JSON.parse(lines[i]); } catch { continue; }
            const alias = modelAlias(entry?.message?.model ?? entry?.model);
            if (alias) { model = alias; break; }
            if (entry?.type === 'assistant' || entry?.role === 'assistant') break; // the last assistant message has no model field: no fallback
            continue;
          }
        } finally { closeSync(fd); }
      }
    } catch { /* reading the transcript must not stop the hook */ }
  }
  return buildUseLine(model, effort);
}

// The handoff steps, common to the warning and the refusal. The role, the coordinator and the name come from sessionRoleFacts
// (the env of the launcher); a session without a role gets `--role worker` without `--coordinator`.
export function handoffSteps({ useLine = '', facts = null, env = process.env } = {}) {
  const role = facts?.role || 'worker';
  const coordinator = facts?.coordinator ? ` --coordinator ${facts.coordinator}` : '';
  const name = facts?.name || 'session';
  const file = handoffFileName(env);
  const marker = takeoverMarker(env);
  const first = useLine ? useLine : '(no use line: Jev chooses the model and effort of the successor at start)';
  return [
    'HANDOFF STEPS:',
    `1. Write the file ${file} in the directory of your brief or notes (Write/Edit on this file are allowed): the first line is \`${first}\`; then the brief to carry out, the state, notes, what is left, full file paths, and the first step for the successor: append at the end of this file a line \`${marker} <successor name> <ISO time>\` and send SendMessage to this session and to the coordinator.`,
    `2. Start the successor (Bash, exactly one command): ${launcherCommand(env)} --role ${role}${coordinator} --brief <path of ${file}> --name "${name} (successor)"`,
    '3. Send SendMessage to the coordinator: the name and id of the new session.',
    `4. Wait for the confirmation of the takeover (the ${marker} line in the file), doing no other work.`,
  ].join('\n');
}

export function warningText({ sizeBytes, useLine = '', facts = null, env = process.env } = {}) {
  const mib = sizeBytes / MIB;
  return `[OMC HANDOFF] The transcript of this session is ${mib.toFixed(1)} MiB. From ${HANDOFF_BLOCK_BYTES / MIB} MiB with an active ultragoal the /goal guard lets only the handoff tools through (writing ${handoffFileName(env)}, reads, ${launcherCommand(env)}, SendMessage), and after the ${takeoverMarker(env)} line it refuses everything. Consider handing the session over now.\n${handoffSteps({ useLine, facts, env })}`;
}

export function refusalText({ useLine = '', facts = null, successorAlreadyStarted = false, env = process.env } = {}) {
  const notes = [
    `[OMC HANDOFF] Transcript over ${HANDOFF_BLOCK_BYTES / MIB} MiB with an active ultragoal: hand the session over. Only the handoff tools are allowed: Write and Edit on a file whose base name is ${handoffFileName(env)} in the working directory of the session or in the session's .omc state directory, for a file that does not exist or was written earlier by this session; Read, Grep, Glob; ToolSearch, ListAgents, SendMessage; Bash with one ${launcherCommand(env)} command with --brief equal to the registered handoff path, once per handoff. Other tools are refused.`,
    successorAlreadyStarted ? `The successor has already been started: ${launcherCommand(env)} can be run only once per handoff.` : '',
    'If you cannot hand the session over, end your turn with a line `BLOCKED: <reason, at least 20 characters>`.',
  ].filter(Boolean);
  return `${notes.join(' ')}\n${handoffSteps({ useLine, facts, env })}`;
}

export function handedOverText(successorName) {
  const name = String(successorName || '').trim() || 'the successor';
  return `[OMC HANDOFF] The session was handed over to ${name}, end your turn; the coordinator will close the session (claude stop).`;
}

// The state of the session <stateDir>/sessions/<sid>/handoff.json (an atomic write), fields: last_warning_bytes (the frequency
// of warnings: the first above the warning threshold, the next after growth by the step), handoff_path and handoff_hash (the
// path and the hash of the allowed write of the handoff file, for the check of the takeover line) and successor_started.
export function readHandoffState(stateDir, sessionId) {
  try {
    if (!stateDir || typeof sessionId !== 'string' || !sessionId) return {};
    const file = join(stateDir, 'sessions', sessionId, 'handoff.json');
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch { return {}; }
}

export function writeHandoffState(stateDir, sessionId, state) {
  try {
    if (!stateDir || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
    atomicWriteFileSync(
      join(stateDir, 'sessions', sessionId, 'handoff.json'),
      JSON.stringify({ version: 1, ...state, session_id: sessionId, updated: new Date().toISOString() }, null, 2),
    );
  } catch { /* the state does not stop the hook */ }
}

// The first line of the handoff file that starts with the takeover marker; the successor's name is the line without the ISO time.
export function readTakeoverLine(path, env = process.env) {
  try {
    const marker = takeoverMarker(env);
    const content = readFileSync(path, 'utf8');
    const line = content.split('\n').find((l) => l.trimStart().startsWith(marker));
    if (!line) return { found: false, name: '' };
    const parts = line.trimStart().slice(marker.length).trim().split(/\s+/).filter(Boolean);
    parts.pop(); // the ISO time
    return { found: true, name: parts.join(' ') };
  } catch { return { found: false, name: '' }; }
}

// The mode of a main session (testable without the hook): handed over (after the takeover line) > handoff (the /goal guard
// refuses and the transcript is over 25 MiB) > warning (over the warning threshold) > none.
export function assessMode({ sessionId, sizeBytes = null, ultragoalDenial = false, state = null, takeover = null, env = process.env } = {}) {
  if (!sessionId) return 'none';
  if (state?.handoff_path && takeover?.found) return 'handed-over';
  if (ultragoalDenial && typeof sizeBytes === 'number' && sizeBytes > HANDOFF_BLOCK_BYTES) return 'handoff';
  if (typeof sizeBytes === 'number' && sizeBytes > handoffWarnBytes(env)) return 'warning';
  return 'none';
}

// The entry point of the hook before the /goal guard (a main session): (c) after the takeover line every tool is refused
// with a handed-over-refused row; the path of an allowed write of the handoff file goes to the state; (b) the warning from the
// warning threshold (the frequency in the state, a warning row), returned as a context that the hook attaches to the calls that pass.
export function handoffBeforeGuard({ stateDir, sessionId, data, sizeBytes = null, env = process.env }) {
  const none = { output: null, context: '' };
  if (!stateDir || !sessionId || (data.agent_id || data.agentId)) return none; // subagents: no state and none of the main session's warnings
  let state = readHandoffState(stateDir, sessionId);
  if (state.handoff_path) {
    // The takeover line counts only when it appeared after a write of the handoff file by another session (the session has its
    // own registered hash and the file content differs from its last write); the session's own line does not close it.
    if (isHandedOver(state, state.handoff_path, env)) {
      const takeover = readTakeoverLine(state.handoff_path, env);
      writeHandoffRow(stateDir, env, data, 'handed-over-refused', sizeBytes);
      return {
        output: {
          continue: true,
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: handedOverText(takeover.name) },
        },
        context: '',
      };
    }
  }
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.toolInput || data.tool_input || {};
  // The path (and hash) of the handoff file is registered here only in warning mode (a size between the warning threshold and
  // 25 MiB); over 25 MiB overrideUltragoalDenial registers it, after the conditions of Write/Edit (the working directory or the
  // session state, a file that does not exist or was written by this session), so a refused write does not register the path.
  // An ordinary session (a size below the warning threshold) registers nothing.
  if ((toolName === 'Write' || toolName === 'Edit') && typeof sizeBytes === 'number' && sizeBytes > handoffWarnBytes(env)
    && sizeBytes <= HANDOFF_BLOCK_BYTES && isHandoffFileName(toolInput.file_path ?? toolInput.path ?? '', env)) {
    state = registerHandoffWrite(stateDir, sessionId, state, toolName, toolInput);
  }
  if (typeof sizeBytes === 'number' && sizeBytes > handoffWarnBytes(env)) {
    const last = typeof state.last_warning_bytes === 'number' ? state.last_warning_bytes : null;
    if (last === null || sizeBytes - last >= handoffStepBytes(env)) {
      writeHandoffState(stateDir, sessionId, { ...state, last_warning_bytes: sizeBytes });
      writeHandoffRow(stateDir, env, data, 'warning', sizeBytes);
      const useLine = successorUseLine({ sessionId, transcriptPath: data.transcript_path ?? data.transcriptPath, stateDir, env });
      return { output: null, context: warningText({ sizeBytes, useLine, facts: sessionFacts(env), env }) };
    }
  }
  return none;
}

// The entry point of the hook in the branch of the /goal guard's denial (only when readBoundedTranscript recognised the size
// overflow): a subagent passes with a row; a main session in handoff mode: the handoff tools pass (handoff-allowed), the rest
// is refused with the "hand the session over" text (handoff-refused). Null: today's denial, unchanged.
export function overrideUltragoalDenial({ stateDir, sessionId, data, sizeBytes = null, overLimit = false, env = process.env }) {
  if (!overLimit || !sessionId || !stateDir) return null;
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.toolInput || data.tool_input || {};
  if (data.agent_id || data.agentId) { // subagents pass at a transcript over the limit
    writeHandoffRow(stateDir, env, data, 'handoff-subagent', sizeBytes);
    return { continue: true, suppressOutput: true };
  }
  let state = readHandoffState(stateDir, sessionId);
  if (isHandedOver(state, state.handoff_path, env)) return null; // handed over (the hash of another session's write): handoffBeforeGuard issued the denial
  const mode = assessMode({ sessionId, sizeBytes, ultragoalDenial: true, state, env });
  if (mode !== 'handoff') return null;
  // The context of the restrictions on Write/Edit and Bash in handoff mode.
  const context = { cwd: String(data.cwd ?? ''), sessionStateDir: join(stateDir, 'sessions', sessionId), state, env };
  if (handoffModeTools(toolName, toolInput, context)) {
    writeHandoffRow(stateDir, env, data, 'handoff-allowed', sizeBytes);
    if (toolName === 'Write' || toolName === 'Edit') state = registerHandoffWrite(stateDir, sessionId, state, toolName, toolInput);
    if ((toolName === 'Bash' || toolName === 'PowerShell') && isLauncherCommand(toolInput.command ?? '', env)) {
      // Mark launcher attempt to prevent retries. The SubagentStart hook should confirm success by updating to successor_started: true.
      // If the launcher fails, this flag will prevent retries until the session is manually fixed.
      writeHandoffState(stateDir, sessionId, { ...state, launcher_attempted: true });
    }
    return { continue: true, suppressOutput: true };
  }
  writeHandoffRow(stateDir, env, data, 'handoff-refused', sizeBytes);
  const useLine = successorUseLine({ sessionId, transcriptPath: data.transcript_path ?? data.transcriptPath, stateDir, env });
  return {
    continue: true,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusalText({ useLine, facts: sessionFacts(env), successorAlreadyStarted: state.successor_started === true, env }) },
  };
}
