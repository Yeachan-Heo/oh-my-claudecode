//
// Progress detection for the ultragoal Stop guard: decide, from the stream of
// tool calls, whether an agent session made real progress since the last time
// its Stop was blocked. A series of Stop blocks without progress is released
// after the release threshold instead of blocking until the reinforcement cap.
//
// NO IMPORTS, on purpose: pure JavaScript with a local FNV-1a hash, so the
// module stays self-contained and cheap to load from any hook script.
//
// Accumulator state (JSON-serialisable, persisted by the caller between calls;
// every list keeps only its newest MAX_ENTRIES entries):
//   { paths: [...], errorSignatures: [...], failedKeys: [...], tests: { passing, failingMin } }
//
// `tests` holds the record test counts: the highest passing count seen and the
// lowest failing count seen (both initially unknown, null).
//

export const MAX_BLOCKS_WITHOUT_PROGRESS = 6; // the Stop is released once a block series exceeds this number
const MAX_ENTRIES = 64; // newest-entries cap per accumulator list
const LONG_CALL_MS = 60000; // a call that ran for a minute or longer is progress
const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "ToolSearch", "WebFetch", "WebSearch", "NotebookRead", "TodoRead", "TodoWrite",
]); // read-only and search tools are never progress; TodoWrite edits the todo list, not a saved work file
const SAVING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]); // the file-saving tools

function hash32(s) {
  // FNV-1a 32-bit as 8 hex digits; a local stable hash, no crypto import.
  let h = 0x811c9dc5;
  const text = String(s ?? "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = (h * 0x01000193) >>> 0; // >>> 0 keeps the multiplication 32-bit in the JS float world
  }
  return h.toString(16).padStart(8, "0");
}

export function normalizeSignature(text) {
  // The error-signature source text: temp paths, UUIDs, date-times, times of
  // day, 13-digit epoch milliseconds, hex runs of 12 or more characters and
  // other numbers of 2 or more digits collapse to fixed placeholders.
  return String(text ?? '').slice(0, 2000)
    .replace(/(\/(?:var|tmp|temp)\/[^\s"'`]{0,120})/gi, '<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<u>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, '<t>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<t>')
    .replace(/\b1\d{12}\b/g, '<t>')
    .replace(/(?<![0-9a-zA-Z_])[0-9a-f]{12,}(?![0-9a-zA-Z])/gi, '<h>')
    .replace(/\b\d{2,}\b/g, '<n>');
}
const BLOCKED_EXIT_TEMPLATE = "reason, at least 20 characters";

export function isAcknowledgedBlockedExit(message) {
  // The acknowledged blocked exit: a line of the final message that, after
  // optional markdown marks (dash, asterisk, quote, bold), starts with the
  // word BLOCKED followed by a colon and a reason of at least 20 characters.
  // Placeholder reasons (starting with "<" or equal to the template
  // sentence) are rejected; a message that merely contains the word blocked
  // elsewhere does not count.
  if (typeof message !== "string") return false;
  for (const line of message.split("\n")) {
    const m = line.match(/^[>\-*\s]*\**\s*blocked\**\s*:\s*\**\s*(.+)$/i);
    if (!m) continue;
    const reason = m[1].trim();
    if (reason.length < 20) continue;
    if (reason.startsWith("<")) continue;
    if (reason.toLowerCase() === BLOCKED_EXIT_TEMPLATE) continue;
    return true;
  }
  return false;
}
function flattenResult(result) {
  // A result that is an array of content parts is flattened to its text
  // parts joined by newlines; anything else becomes a string or "".
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).filter((t) => t.length > 0).join("\n");
  }
  return "";
}

function callKey(call) {
  // The key of one call: hash of the tool name plus the first 500 characters
  // of the JSON-serialised input, for the failure-turned-success rule.
  const input = (call && typeof call === "object") ? call.input : null;
  return hash32(`${String(call?.tool ?? "")}|${JSON.stringify(input ?? null).slice(0, 500)}`);
}

function savePaths(input) {
  // The saved paths of a write call: the file-path field, the notebook-path
  // field and every element of an edits list.
  const w = (input && typeof input === "object") ? input : {};
  const paths = [];
  for (const field of ["file_path", "notebook_path"]) {
    if (typeof w[field] === "string" && w[field].trim()) paths.push(w[field].trim());
  }
  if (Array.isArray(w.edits)) {
    for (const e of w.edits) {
      if (e && typeof e.file_path === "string" && e.file_path.trim()) paths.push(e.file_path.trim());
    }
  }
  return paths;
}
function carriesDenialMarker(text) {
  // The marker of a guard denial: a bracketed token containing the word for
  // denial, a 16-hex-digit id and a counter, like [DENIED 0123456789abcdef #2].
  // A denial is never progress and overrides every other rule.
  const s = String(text ?? "");
  if (!s.includes("[")) return false;
  for (const m of s.matchAll(/\[([^\]\n]{0,160})\]/g)) {
    const token = m[1];
    if (!/\b(?:denied|denial)\b/i.test(token)) continue;
    if (!/[0-9a-f]{16}/i.test(token)) continue;
    if (/#\d+/.test(token)) return true;
  }
  return false;
}
function isTestSummary(text) {
  // A summary is a number followed by "passed"/"passing" or "failed"/
  // "failing", optionally with the word "tests" in between, case-insensitive.
  return /\b\d+\s+(?:tests\s+)?(?:passed|passing|failed|failing)\b/i.test(String(text ?? ""));
}
function testCounts(text) {
  // The first matching summary in the text yields the passing and failing
  // counts; both null when no summary is found.
  const s = String(text ?? "");
  const pass = s.match(/\b(\d+)\s+(?:tests\s+)?(?:passed|passing)\b/i);
  const fail = s.match(/\b(\d+)\s+(?:tests\s+)?(?:failed|failing)\b/i);
  return {
    passing: pass ? Number(pass[1]) : null,
    failing: fail ? Number(fail[1]) : null,
  };
}
function rememberNew(list, value) {
  // A set with insertion order, capped to its newest MAX_ENTRIES entries.
  if (!list.includes(value)) {
    list.push(value);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  }
}

function normalizeAccumulator(prev) {
  // Tolerant read of the persisted accumulator state.
  const p = (prev && typeof prev === "object" && !Array.isArray(prev)) ? prev : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-MAX_ENTRIES) : []);
  const tests = (p.tests && typeof p.tests === "object" && !Array.isArray(p.tests)) ? p.tests : {};
  return {
    paths: list(p.paths),
    errorSignatures: list(p.errorSignatures),
    failedKeys: list(p.failedKeys),
    tests: {
      passing: (typeof tests.passing === "number" && Number.isFinite(tests.passing)) ? tests.passing : null,
      failingMin: (typeof tests.failingMin === "number" && Number.isFinite(tests.failingMin)) ? tests.failingMin : null,
    },
  };
}
function applyCall(state, call) {
  // The progress rules for one call. A guard denial overrides everything and
  // read-only tools are never progress; otherwise every rule is evaluated and
  // applied to the accumulator (a call that shows several signs is progress,
  // and none of the state updates is skipped by an earlier sign).
  const input = (call && typeof call === "object" && call.input && typeof call.input === "object") ? call.input : null;
  if (!input) return { progress: false, reason: "none" };
  const resultText = flattenResult(call?.result);
  if (carriesDenialMarker(resultText)) return { progress: false, reason: "guard-denial" };
  const tool = typeof call?.tool === "string" ? call.tool : "";
  if (READ_ONLY_TOOLS.has(tool)) return { progress: false, reason: "read-only" };
  const signs = [];
  let quiet = "none"; // the reason reported when no sign applies

  // A saved path not saved before by this session.
  if (SAVING_TOOLS.has(tool)) {
    const paths = savePaths(input);
    const isNew = paths.some((path) => !state.paths.includes(path));
    for (const path of paths) rememberNew(state.paths, path);
    if (isNew) signs.push("new-path");
    else if (paths.length > 0) quiet = "same-path";
  }

  // A test summary that improves the record (the first summary sets it).
  const counts = isTestSummary(resultText) ? testCounts(resultText) : null;
  if (counts && (counts.passing !== null || counts.failing !== null)) {
    let record = false;
    if (counts.passing !== null && (state.tests.passing === null || counts.passing > state.tests.passing)) {
      state.tests.passing = counts.passing;
      record = true;
    }
    if (counts.failing !== null && (state.tests.failingMin === null || counts.failing < state.tests.failingMin)) {
      state.tests.failingMin = counts.failing;
      record = true;
    }
    if (record) signs.push("test-record");
    else if (quiet === "none") quiet = "no-record";
  }

  // A failure with a new error signature; a success after the same call failed.
  const ok = call?.ok;
  const key = callKey(call);
  if (ok === false) {
    rememberNew(state.failedKeys, key);
    if (resultText) {
      const signature = hash32(normalizeSignature(resultText));
      if (!state.errorSignatures.includes(signature)) {
        rememberNew(state.errorSignatures, signature);
        signs.push("new-error");
      } else if (quiet === "none") quiet = "error-repeat";
    } else if (quiet === "none") quiet = "no-result";
  } else if (ok === true && state.failedKeys.includes(key)) {
    state.failedKeys.splice(state.failedKeys.indexOf(key), 1);
    signs.push("failure-success");
  }

  // A call that ran for a minute or longer.
  if (typeof call?.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= LONG_CALL_MS) signs.push("long-call");

  return signs.length > 0 ? { progress: true, reason: signs[0] } : { progress: false, reason: quiet };
}
export class ProgressState {
  // The progress accumulator persisted between Stop blocks; constructed
  // from the previous persisted state when one exists.
  constructor(prev) {
    const acc = normalizeAccumulator(prev);
    this.paths = acc.paths;
    this.errorSignatures = acc.errorSignatures;
    this.failedKeys = acc.failedKeys;
    this.tests = acc.tests;
  }

  add(call) {
    return applyCall(this, call);
  }

  state() {
    // JSON-serialisable snapshot: every list already capped to MAX_ENTRIES.
    return {
      paths: [...this.paths],
      errorSignatures: [...this.errorSignatures],
      failedKeys: [...this.failedKeys],
      tests: { passing: this.tests.passing, failingMin: this.tests.failingMin },
    };
  }
}
export function classifyTranscript(text, progress, fromTsMs = 0) {
  // Classify a JSONL transcript: assistant tool-use blocks and user
  // tool-result blocks paired by id, durations taken from the row
  // timestamps (a duration stays unknown when either row has none); a
  // truncated last line is skipped. Rows without a usable timestamp are
  // classified like any other, unless a window start (fromTsMs > 0) is given:
  // such a row cannot be placed in the window and stays outside it.
  const result = { calls: 0, progress: false };
  if (typeof text !== "string" || !text.trim()) return result;
  const pending = new Map();
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;
    let row = null;
    try { row = JSON.parse(rawLine); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const tsMs = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : 0;
    const parts = row.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (row.type === "assistant" && part?.type === "tool_use") {
        pending.set(part.id, { tool: part.name, input: part.input, ts: tsMs, ok: null, result: null, durationMs: null });
        if (SAVING_TOOLS.has(part.name) && tsMs >= fromTsMs) {
          const r = progress.add({ tool: part.name, input: part.input, result: null, durationMs: null, ok: null });
          if (r.progress) result.progress = true;
          result.calls += 1;
        }
        continue;
      }
      if (row.type === "user" && part?.type === "tool_result") {
        const call = pending.get(part.tool_use_id);
        if (call && call.ts > 0 && tsMs > call.ts) call.durationMs = tsMs - call.ts;
        if (call && tsMs >= fromTsMs) {
          call.ok = part.is_error !== true;
          call.result = flattenResult(part.content);
          call.durationMs = (call.durationMs === null) ? null : call.durationMs;
          // Count the call regardless of denial markers; progress.add() checks for denials
          const r = progress.add(call);
          if (r.progress) result.progress = true;
          result.calls += 1;
        }
      }
    }
  }
  return result;
}
