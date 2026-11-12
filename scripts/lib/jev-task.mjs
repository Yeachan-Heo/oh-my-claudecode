// omc-lokalne P14: the owner's task for the tool gate (stage 5 of the Jev add-ons plan).
// recordOwnerTask(data, stateDir) is called by the UserPromptSubmit hook (keyword-detector.mjs): it writes the three latest real owner
// messages (each up to 2000 characters) and the assistant message just before them (the question the owner answers, up to 2000
// characters) to <logdir>/sesje/<session_id>.json, after masking secrets. Since record version 2 (decision 3 changed by the owner, 2026-11-09)
// it also keeps the first real owner message of the session (1300 characters from its start and 300 from its end, set once) and the plan the
// task refers to ({ path, title }: the first plan path of the first message, else the last plan path of a later message, updated when the owner
// names a new one). readOwnerTask(sessionId, stateDir) reads it back for the gate (pre-tool-enforcer.mjs), readSubagentPrompt reads the first
// user message of a subagent's own transcript. The transcript is read once per prompt (its start once per session), never per tool call.
// Files older than 7 days are removed opportunistically at write time (no SessionStart needed).
// Written from scratch (clean room). Every function is fail-open: it returns null and never throws.

import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { maskSecrets, shellLogDir } from './jev-panel-host.mjs';

export const OWNER_MESSAGES_KEPT = 3;
export const OWNER_MESSAGE_MAX = 2000;
export const ASSISTANT_QUESTION_MAX = 2000;
export const SUBAGENT_PROMPT_MAX = 6000;
export const FIRST_MESSAGE_HEAD = 1300; // the first message of the session: this many characters from its start ...
export const FIRST_MESSAGE_TAIL = 300; // ... and this many from its end (a message of up to HEAD + TAIL characters is kept whole)
export const FIRST_MESSAGE_SOURCE_MAX = 100000; // the longest first message read from the transcript (for masking and for the plan path)
export const PLAN_TITLE_MAX = 200;
export const PLAN_PATH_MAX = 200;
export const TASK_RECORD_VERSION = 2;
export const TASK_FILE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SWEEP_EVERY_MS = 3600 * 1000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024; // the start of the transcript read for the first owner message of the session
// N11h2 (and its review): masking before a cut. A private key block is masked in the whole text first (keyBlocksMasked, linear): a block with
// END from BEGIN to END, a header without END with the key body after it (base64 lines, "Name: value" lines, empty lines; prose after it stays,
// review MEDIUM 2). The full maskSecrets is not linear on every input (a long run of KEY: 100 000 characters about 6 s), so it runs on a window:
// the kept part plus MASK_MARGIN characters, its far edge moved to a line break at most LINE_REACH away, so every rule sees the whole line of
// the text it masks (a name before a long value, Cookie:, mysql ... -p; review HIGH 1, MEDIUM 3); a line too long for that is left out of a
// tail and cut at a space in a head, so no window edge splits a word.
const MASK_MARGIN = 1000;
const LINE_REACH = 5000;
const WHOLE_MAX = 14000; // a first message up to this long is masked whole, as before N11h2 (above it the head and tail windows never overlap)
// The header and the footer of SECRET_PEM (scripts/lib/jev-sekrety.mjs): words of the type end with a space or one hyphen, so a run stops at a
// double hyphen and the scan stays linear.
const KEY_HEAD = /-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}/g;
const KEY_END = /-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}/g;
const KEY_BODY_LINE = /^(?:[A-Za-z0-9+/=]{1,200}|[A-Za-z][A-Za-z0-9-]{0,40}: [^\n]{0,300}|)\r?$/;
// The end of the body of a header without END: the rest of the header's line, then every line that may be a key's (the newline after it stays).
function keyBodyEnd(s, from) {
  let p = s.indexOf('\n', from);
  for (;;) {
    if (p < 0) return s.length;
    const q = s.indexOf('\n', p + 1);
    const e = q < 0 ? s.length : q;
    if (e - p - 1 > 400 || !KEY_BODY_LINE.test(s.slice(p + 1, e))) return p;
    if (q < 0) return s.length;
    p = q;
  }
}
// Every header and every footer is read once (the first END after a header ends its block; after a header without any END later no header has
// one), so the work is linear.
function keyBlocksMasked(text) {
  const s = String(text ?? '');
  if (!s.includes('PRIVATE KEY')) return s;
  let out = '';
  let last = 0;
  let end = null;
  let noEnd = false;
  let m;
  KEY_HEAD.lastIndex = 0;
  while ((m = KEY_HEAD.exec(s))) {
    const from = m.index + m[0].length;
    if (!noEnd && (end === null || end.index < from)) {
      KEY_END.lastIndex = from;
      end = KEY_END.exec(s);
      if (!end) noEnd = true;
    }
    out += `${s.slice(last, from)}***${noEnd ? '' : end[0]}`;
    last = noEnd ? keyBodyEnd(s, from) : end.index + end[0].length;
    KEY_HEAD.lastIndex = last;
  }
  return out + s.slice(last);
}
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
export function maskedHead(text, max) {
  if (!(max > 0)) return '';
  const s = keyBlocksMasked(text);
  let end = Math.min(s.length, max + MASK_MARGIN);
  if (end < s.length) {
    const nl = s.indexOf('\n', end);
    if (nl >= 0 && nl - end <= LINE_REACH) end = nl;
    else { while (end > 0 && !isSpace(s[end - 1])) end--; } // the window ends after a whole word
  }
  return maskSecrets(s.slice(0, end)).slice(0, max);
}
export function maskedTail(text, max) {
  if (!(max > 0)) return '';
  const s = keyBlocksMasked(text);
  let start = Math.max(0, s.length - max - MASK_MARGIN);
  if (start > 0) {
    const line = s.lastIndexOf('\n', start - 1) + 1;
    if (start - line <= LINE_REACH) start = line; // the window starts at a line's start
    else { const nl = s.indexOf('\n', start); start = nl < 0 ? s.length : nl + 1; } // a line too long to read whole is left out
  }
  return maskSecrets(s.slice(start)).slice(-max);
}
// The first message as capFirstMessage keeps it, masked: up to WHOLE_MAX masked whole (the count of the marker as before), else the masked head
// and tail with the marker between (the count from the text with key blocks masked).
function maskedFirstMessage(text) {
  const s = keyBlocksMasked(text);
  if (s.length <= WHOLE_MAX) return capFirstMessage(maskSecrets(s));
  return `${maskedHead(s, FIRST_MESSAGE_HEAD)}\n[... pominięto ${s.length - FIRST_MESSAGE_HEAD - FIRST_MESSAGE_TAIL} znaków ...]\n${maskedTail(s, FIRST_MESSAGE_TAIL)}`;
}
// The text without <system-reminder> blocks, as raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '') but linear (the regex is
// quadratic on many openers without a closer: 1 000 000 characters about 25 s; review LOW 6).
function withoutReminders(raw) {
  let out = '';
  let i = 0;
  for (;;) {
    const a = raw.indexOf('<system-reminder>', i);
    const b = a < 0 ? -1 : raw.indexOf('</system-reminder>', a);
    if (b < 0) return out + raw.slice(i);
    out += raw.slice(i, a);
    i = b + '</system-reminder>'.length;
  }
}
const PLAN_HEAD_BYTES = 8 * 1024; // the start of a plan file read for its title
const SUBAGENT_HEAD_BYTES = 256 * 1024;
// Entries of the "user" type that are system messages, not the owner's own words (same list as the parent-message reader of
// pre-tool-enforcer.mjs, PARENT_MESSAGE_SKIP_PREFIXES; that script runs main() on import, so the list is repeated here).
export const SKIP_PREFIXES = [
  '<task-notification>', '<teammate-message', '<side-sessions-event>', '<command-name>', '<command-message>',
  '<local-command-stdout>', '<local-command-stderr>', 'Another Claude session sent a message',
  // Messages of other sessions and agents (herdr, SendMessage, notifications of the harness) are not the owner's words and must not satisfy the
  // service exception. The forms are those seen in transcripts and in the herdr skill; an unknown form is not cut.
  '<herdr', '[herdr', 'herdr-msg', '<agent-message', '<system-notification', '[SYSTEM NOTIFICATION', '<channel', '<peer-message', '<send-message',
];
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Directory of the session files: next to the Jev logs, in one place whatever the working directory of the call is (OMC_JEV_LOG_DIR, else
// ~/.omc/state/jev). The prompt hook and the gate of a subagent or of another repository run with different working directories, so a
// project-relative state root would not find the file the prompt hook wrote. The state directory argument is kept for the callers.
export function sessionsDir(stateDir, env = process.env) {
  void stateDir;
  return join(shellLogDir(env), 'sesje');
}

function sessionFile(sessionId, stateDir, env) {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) && !sessionId.includes('..')
    ? join(sessionsDir(stateDir, env), `${sessionId}.json`)
    : null;
}

// Text of a hook prompt or transcript message with system reminders cut out; '' for a system message.
export function ownerText(content) {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';
  const text = withoutReminders(raw).trim();
  return text && !SKIP_PREFIXES.some((p) => text.startsWith(p)) ? text : '';
}

// The tail of a regular file (not a symlink): last maxBytes, as text, or '' on any problem.
function readTail(path, maxBytes) {
  let fd;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) return '';
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// The head of a regular file (not a symlink): first maxBytes, as text (a line cut at the end fails to parse and is skipped by the callers), or ''.
function readHead(path, maxBytes) {
  let fd;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) return '';
    fd = openSync(path, 'r');
    const length = Math.min(fstatSync(fd).size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// The first real owner message of a session: from the start of the transcript (the first MiB), the first entry of type user that is not a tool
// result, a meta entry, a compaction summary, a side chain or a system message (the same filters as ownerText and lastAssistantText). The whole
// text up to FIRST_MESSAGE_SOURCE_MAX characters, or null when the transcript has none (no file, empty, nothing real in its first MiB).
export function firstOwnerMessage(transcriptPath, maxChars = FIRST_MESSAGE_SOURCE_MAX) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  for (const line of readHead(transcriptPath, TRANSCRIPT_HEAD_BYTES).split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
    const text = ownerText(content);
    if (text) return text.slice(0, maxChars);
  }
  return null;
}

// The first message of the session as it is kept: whole up to HEAD + TAIL characters, else the start and the end with a marker between.
export function capFirstMessage(text) {
  const s = String(text ?? '');
  if (s.length <= FIRST_MESSAGE_HEAD + FIRST_MESSAGE_TAIL) return s;
  return `${s.slice(0, FIRST_MESSAGE_HEAD)}\n[... pominięto ${s.length - FIRST_MESSAGE_HEAD - FIRST_MESSAGE_TAIL} znaków ...]\n${s.slice(-FIRST_MESSAGE_TAIL)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The plan the task refers to. findPlanRef(text) -> { path, title } | null: the first absolute path (X:\..., X:/..., /..., ~/...) of a .md file
// whose name contains "plan" (any case) or which lies in a directory named plans (.omc/plans/). The title is the first "# ..." line among the
// first 8 KB of the file (200 characters at most); without the file or a heading, only the path. A path in D:\Vault or ~/.vault (any spelling) or
// of a secret file is never read and never returned: such a plan is skipped as a whole (its file name does not go to Jev either). A symbolic
// link is not followed. The path is cut to 200 characters.
// ---------------------------------------------------------------------------------------------------------------------------

const PLAN_PATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`<>|*?\n\r]{0,300}?\.md(?![A-Za-z0-9_])|(?<![A-Za-z0-9_.~/\\$-])~[\\/][^\s"'`<>|*?\n\r]{0,300}?\.md(?![A-Za-z0-9_])|(?<![A-Za-z0-9_.~/\\$:-])\/(?![/*])[^\s"'`<>|*?\n\r]{0,300}?\.md(?![A-Za-z0-9_])/g;
const SECRET_SEGMENTS = new Set(['vault', '.vault', '.ssh', '.gnupg', '.aws']);
const SECRET_FILES = /^(?:\.git-credentials|\.credentials\.json|platform\.json|hosts\.yml|\.env(?:\..*)?|id_[a-z0-9]+)$/i;

// One lower-case slash form of a path, enough to tell a secret location from the rest: slashes, the Windows namespaces and the administrative share
// of this machine, /d, /mnt/d and /cygdrive/d as d:, trailing dots and spaces of a segment (Windows ignores them), . and ..
function lowerPathForm(raw, home) {
  let s = String(raw).replace(/\\/g, '/').replace(/\/{2,}/g, (m, offset) => (offset === 0 && m.length === 2 ? '//' : '/'));
  s = s.replace(/^\/\/[?.]\//, '');
  const share = /^\/\/([^/]+)\/([a-zA-Z])\$(?=\/|$)/.exec(s);
  if (share) s = `${share[2]}:${s.slice(share[0].length) || '/'}`;
  const unix = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/.exec(s);
  if (unix) s = `${unix[1]}:${s.slice(unix[0].length) || '/'}`;
  if (/^~(?:\/|$)/.test(s)) s = `${String(home).replace(/\\/g, '/')}${s.slice(1)}`;
  const out = [];
  for (const segment of s.split('/')) {
    // NTFS alternate data streams and index names (Vault::$INDEX_ALLOCATION, plan.md:stream) name the same file or directory: cut at the colon (not the drive letter)
    const named = /^[a-zA-Z]:$/.test(segment) ? segment : segment.split(':')[0];
    const seg = named.replace(/[. ]+$/, (m) => (named === '.' || named === '..' ? m : ''));
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg.toLowerCase());
  }
  return out;
}

function secretPlanPath(raw, home) {
  const segments = lowerPathForm(raw, home);
  const file = segments.at(-1) ?? '';
  return segments.some((seg) => SECRET_SEGMENTS.has(seg)) || segments.join('/').includes('.config/gh') || SECRET_FILES.test(file);
}

function planTitle(path) {
  let fd;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) return null;
    if (secretPlanPath(realpathSync(path), homedir())) return undefined; // the path leads into a secret place through a directory link: drop the plan as a whole
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(fstatSync(fd).size, PLAN_HEAD_BYTES));
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(buffer.toString('utf8', 0, n));
    return m ? m[1].trim() : null; // cut after masking (findPlanRef, N11h2)
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

export function findPlanRef(text) {
  try {
    const s = String(text ?? '').slice(0, FIRST_MESSAGE_SOURCE_MAX);
    if (!s.includes('.md')) return null;
    const home = homedir();
    PLAN_PATH_RE.lastIndex = 0;
    for (const m of s.matchAll(PLAN_PATH_RE)) {
      const path = m[0];
      const segments = lowerPathForm(path, home);
      const file = segments.at(-1) ?? '';
      if (!/plan/.test(file) && !segments.slice(0, -1).includes('plans')) continue;
      if (secretPlanPath(path, home)) continue;
      let expanded = /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
      // /d/x and /mnt/d/x name the drive D: on Windows (Git Bash, WSL spelling); the file system there knows only D:\x
      if (process.platform === 'win32') { const unix = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)(.*)$/.exec(path); if (unix) expanded = `${unix[1]}:${unix[2] || '/'}`; }
      const title = planTitle(expanded);
      if (title === undefined) continue;
      return { path: path.slice(0, PLAN_PATH_MAX), title: title ? maskedHead(title, PLAN_TITLE_MAX) : null };
    }
  } catch { /* fail-open */ }
  return null;
}

// The plan of a task from its messages: the first plan path of the first message, else the last one named in the later messages.
// source: 'first' | 'later'. Used by the hook (through recordOwnerTask) and by the calibration and replay tools.
export function planForTask(firstMessage, laterMessages = []) {
  const first = findPlanRef(firstMessage);
  if (first) return { ...first, source: 'first' };
  for (let i = laterMessages.length - 1; i >= 0; i--) {
    const later = findPlanRef(laterMessages[i]);
    if (later) return { ...later, source: 'later' };
  }
  return null;
}

// The last assistant message with text before the owner's new prompt: from the end of the transcript backwards, tool results and
// system messages skipped; the new prompt itself may already be in the transcript (skipped once); another real owner message met
// before any assistant text means the assistant said nothing since then (null). Text bits only, cut to the last maxChars.
export function lastAssistantText(transcriptPath, newPrompt = '', maxChars = ASSISTANT_QUESTION_MAX) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const lines = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split('\n');
  const probe = String(newPrompt || '').trim().slice(0, 200);
  let skippedPrompt = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!entry || entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (entry.isMeta || entry.isCompactSummary) continue;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const text = ownerText(content);
      if (!text) continue;
      if (!skippedPrompt && probe && text.startsWith(probe)) { skippedPrompt = true; continue; }
      return null;
    }
    if (entry.type === 'assistant') {
      const text = typeof content === 'string'
        ? content.trim()
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim() : '';
      if (text) return text.length > maxChars ? text.slice(-maxChars) : text;
    }
  }
  return null;
}

// Prompt of the UserPromptSubmit hook input (several field names are in use).
function promptOf(data) {
  for (const key of ['prompt', 'user_prompt', 'userPrompt', 'message']) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object' && typeof value.content !== 'undefined') {
      const text = ownerText(value.content);
      if (text) return text;
    }
  }
  return '';
}

function sweep(dir, now) {
  try {
    const marker = join(dir, '.sprzatanie');
    let last = 0;
    try { last = statSync(marker).mtimeMs; } catch { /* first run */ }
    if (now - last < SWEEP_EVERY_MS) return;
    writeFileSync(marker, '');
    utimesSync(marker, new Date(now), new Date(now));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      try { if (now - statSync(path).mtimeMs > TASK_FILE_MAX_AGE_MS) unlinkSync(path); } catch { /* gone or busy */ }
    }
  } catch { /* cleanup never breaks the hook */ }
}

// The UserPromptSubmit entry point. Returns the record written, or null (system message, no session id, write failure).
export function recordOwnerTask(data, stateDir, env = process.env) {
  try {
    const sessionId = data?.session_id ?? data?.sessionId;
    const file = sessionFile(sessionId, stateDir, env);
    if (!file) return null;
    const prompt = ownerText(promptOf(data));
    if (!prompt) return null;
    const previous = readOwnerTask(sessionId, stateDir, env);
    const message = maskedHead(prompt, OWNER_MESSAGE_MAX);
    const transcript = data?.transcript_path ?? data?.transcriptPath;
    const question = lastAssistantText(transcript, prompt, Infinity); // whole, cut by maskedTail after masking (N11h2)
    // The first message of the session and the plan: set once (a v1 record has neither, so the start of the transcript is read once for it).
    let first = typeof previous?.first_owner_message === 'string' ? previous.first_owner_message : null;
    let plan = previous?.plan ?? null;
    let planSource = previous?.plan_source ?? null;
    if (first === null) {
      const text = firstOwnerMessage(transcript, Infinity) ?? prompt; // whole: masked before the cut (N11h2, review LOW 4); findPlanRef cuts its own copy
      first = maskedFirstMessage(text);
      const found = findPlanRef(text);
      if (found) { plan = found; planSource = 'first'; }
    }
    if (planSource !== 'first') {
      const found = findPlanRef(prompt);
      if (found) { plan = found; planSource = 'later'; }
    }
    const record = {
      v: TASK_RECORD_VERSION,
      session_id: sessionId,
      updated: new Date().toISOString(),
      owner_messages: [...(previous?.owner_messages ?? []), message].slice(-OWNER_MESSAGES_KEPT),
      assistant_before_last: question ? maskedTail(question, ASSISTANT_QUESTION_MAX) : null,
      first_owner_message: first,
      plan: plan ? { path: maskSecrets(plan.path).slice(0, PLAN_PATH_MAX), title: plan.title ? maskSecrets(plan.title).slice(0, PLAN_TITLE_MAX) : null } : null,
      plan_source: plan ? planSource : null,
    };
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, file);
    sweep(dir, Date.now());
    return record;
  } catch {
    return null;
  }
}

// { owner_messages: string[], assistant_before_last: string | null, updated, first_owner_message: string | null, plan: { path, title } | null,
// plan_source } or null when there is no record. A record of version 1 has no first message and no plan (null).
export function readOwnerTask(sessionId, stateDir, env = process.env) {
  try {
    const file = sessionFile(sessionId, stateDir, env);
    if (!file || !existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(record?.owner_messages)) return null;
    const plan = record.plan && typeof record.plan === 'object' && typeof record.plan.path === 'string' && record.plan.path
      ? { path: record.plan.path.slice(0, PLAN_PATH_MAX), title: typeof record.plan.title === 'string' && record.plan.title ? record.plan.title.slice(0, PLAN_TITLE_MAX) : null }
      : null;
    return {
      owner_messages: record.owner_messages.filter((m) => typeof m === 'string').slice(-OWNER_MESSAGES_KEPT),
      assistant_before_last: typeof record.assistant_before_last === 'string' ? record.assistant_before_last : null,
      updated: typeof record.updated === 'string' ? record.updated : null,
      first_owner_message: typeof record.first_owner_message === 'string' && record.first_owner_message ? record.first_owner_message : null,
      plan,
      plan_source: plan && (record.plan_source === 'first' || record.plan_source === 'later') ? record.plan_source : null,
    };
  } catch {
    return null;
  }
}

// <transcript without .jsonl>/subagents/agent-<agent_id>.jsonl (stage 0 trial 7: the first user message of that file is the
// subagent's prompt, present from its first tool call).
export function subagentTranscriptPath(transcriptPath, agentId) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  return join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
}

export function readSubagentPrompt(transcriptPath, agentId, maxChars = SUBAGENT_PROMPT_MAX) {
  try {
    const path = subagentTranscriptPath(transcriptPath, agentId);
    if (!path || !existsSync(path)) return null;
    let fd;
    let head;
    try {
      const link = lstatSync(path);
      if (link.isSymbolicLink() || !link.isFile()) return null;
      fd = openSync(path, 'r');
      const buffer = Buffer.allocUnsafe(Math.min(link.size, SUBAGENT_HEAD_BYTES));
      const n = readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.toString('utf8', 0, n);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    }
    for (const line of head.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'user') continue;
      const content = entry.message?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const raw = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
      const text = withoutReminders(raw).trim();
      if (text) return maskedHead(text, maxChars);
    }
  } catch { /* fail-open */ }
  return null;
}
