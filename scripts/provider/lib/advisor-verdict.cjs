'use strict';
// Verdict, a three-state parser and a file:line citation validator for the advisor (provider-advisor.cjs).
// Answer format of the advisor (input switch OMC_PROVIDER_ADVISOR_INPUT=1 with OMC_PROVIDER_ADVISOR_PROTOCOL):
//   first non-empty line  TOKEN: <token>             (random token from the input; proof of reading; missing = a failed consultation, not advice)
//   a line                VERDICT: <value>           (closed dictionary per profile)
//   lines                 CONCERN 1: ... CONCERN n: ... (plan only, 1..5)
//   lines                 SOURCE: <file>:<line>      (evidence; file relative to the worktree, line from the ranges shown in the input)
//   lines                 ACCEPTANCE CRITERIA: ...   (plan only; the journal keeps only the number of characters, no text)
//   one line              SUMMARY: <text>
// Verdict dictionaries per profile: plan = LGTM | CONCERNS; rescue = proceed | proceed-with-changes | reconsider;
// final = GO | STOP. Status names of the resolution: ok, no-advice, stale, invalid-citations, stop (STOP = the gate
// failed with advice delivered).
// Three-state parser: advice | no advice | (final) gate failed. The final gate is fail-closed: an answer outside the
// format, a mere announcement or an empty one on exit code 0 is no-advice (an error status in the journal, not an
// approval); GO without at least one valid citation or with an invalid one does not pass (invalid-citations); GO after
// the files of the diff changed since the input is stale and does not pass. The advisory mode (plan, rescue) is
// fail-open: no advice does not block (exit 0), the worker gets the message "advice unavailable, continue or report to
// the lead".
// Citation validator: the opinion of the advisor is a hypothesis to validate; the path of a citation must belong to the
// files shown to the advisor (the input metadata), the line to the ranges actually shown (a citation in an omitted
// middle is line-outside-shown, not "in range"); an unparsable citation is unparsed.
// Protective cap of the advice injected into the worker context: the TOKEN and VERDICT lines are never trimmed, the
// rest is trimmed on whole lines with a trimming marker; the cap is a starting parameter to calibrate by measuring; no
// word limit in the role prompt. No network, no key, no model hard-coded.
const { randomBytes } = require('node:crypto');
const { ADVISOR_STATUSES, ADVISOR_VERDICTS } = require('./vocab.cjs');

// Role profiles (OMC_PROVIDER_ADVISOR_PROTOCOL) and their closed verdict dictionaries.
const PROTOCOLS = Object.keys(ADVISOR_VERDICTS);
const VERDICTS = ADVISOR_VERDICTS;

// Random control token of the input (hex, 16 characters); the advisor script generates it per consultation.
function controlToken() {
  return randomBytes(8).toString('hex');
}

// Threshold and pattern of an announcement: an answer without tools may be a mere announcement; such content is no
// advice (a stub), not an answer. Tune the values on samples of answers after measuring.
const ANNOUNCEMENT_THRESHOLD = 60;
const ANNOUNCEMENT_PATTERN = /^(right away |analy[sz]e|i will check|starting|give me a moment|let me|i'll|i will|analyzing|checking)/i;

// Parsing the role profiles file (advisor-role.md): headings `## COMMON`, `## PLAN`, `## RESCUE`, `## FINAL`;
// the section name is exactly one of the four, the content of a section is the lines up to the next heading.
// Returns { common, profiles: {plan, rescue, final} }.
const SECTION_NAMES = { COMMON: 'common', PLAN: 'plan', RESCUE: 'rescue', FINAL: 'final' };
function parseProfiles(text) {
  const sections = { common: [], profiles: {} };
  let current = 'common';
  for (const line of String(text ?? '').split('\n')) {
    const m = /^##\s+([A-Z]+)\s*$/.exec(line);
    if (m) {
      const name = SECTION_NAMES[m[1]] || m[1].toLowerCase();
      current = name === 'common' ? 'common' : name;
      if (current !== 'common') sections.profiles[current] = sections.profiles[current] || [];
      continue;
    }
    if (current === 'common') sections.common.push(line);
    else sections.profiles[current].push(line);
  }
  const clean = (lines) => lines.join('\n').replace(/^\n+|\s+$/g, '');
  const profiles = {};
  for (const [name, lines] of Object.entries(sections.profiles)) profiles[name] = clean(lines);
  return { common: clean(sections.common), profiles };
}

// System prompt of the advisor for a protocol: the common part plus the profile; null when the profile is missing
// (the role falls back to the plain role file).
function systemRole(markdown, protocol) {
  if (!PROTOCOLS.includes(protocol)) return null;
  const { common, profiles } = parseProfiles(markdown);
  const profile = profiles[protocol];
  if (!profile) return null;
  return [common, profile].filter(Boolean).join('\n\n');
}

// Three-state parser of the answer. Returns { state: 'ok'|'none', reason, verdict, controlLine, concerns, citations,
// summary, criteria, text }. state 'ok' = a correct control line and a verdict in the dictionary of the profile.
function parse(text, { protocol, token } = {}) {
  const raw = String(text ?? '');
  const none = (reason) => ({ state: 'none', reason, verdict: null, controlLine: false, concerns: [], citations: [], summary: null, criteria: null, text: raw });
  if (!raw.trim()) return none('empty');
  const lines = raw.split('\n').map((l) => l.trim());
  const first = lines.find((l) => l.length) || '';
  if (!token) return none('no-input-token');
  const mTok = /^TOKEN:\s*(\S+)\s*$/.exec(first);
  if (!mTok) return none(ANNOUNCEMENT_PATTERN.test(first) || raw.length < ANNOUNCEMENT_THRESHOLD ? 'announcement' : 'no-control-line');
  if (mTok[1] !== token) return none('wrong-token');
  const verdictRow = lines.find((l) => /^VERDICT:/.test(l));
  if (!verdictRow) return none(ADVISOR_STATUSES.NO_VERDICT);
  const verdict = verdictRow.slice('VERDICT:'.length).trim();
  const dictionary = VERDICTS[protocol] || [];
  if (!dictionary.includes(verdict)) return none('verdict-outside-dictionary');
  const concerns = lines.filter((l) => /^CONCERN\s*\d*:/.test(l)).map((l) => l.replace(/^CONCERN\s*\d*:\s*/, ''));
  if (protocol === 'plan') { // the number of points is enforced; over the limit means a format mismatch
    if (verdict === 'LGTM' && concerns.length) return none('concerns-with-lgtm');
    if (verdict === 'CONCERNS' && (concerns.length < 1 || concerns.length > 5)) return none('wrong-concern-count');
  }
  const summaryRow = lines.find((l) => /^SUMMARY:/.test(l));
  if (!summaryRow || !summaryRow.slice('SUMMARY:'.length).trim()) return none('no-summary');
  const citations = [];
  for (const l of lines) {
    const m = /^SOURCE:\s*(.+)$/.exec(l);
    if (!m) continue;
    const p = /^(.+):(\d+)$/.exec(m[1].trim());
    if (p) citations.push({ file: p[1].trim(), line: Number(p[2]), raw: m[1].trim() });
    else citations.push({ file: null, line: null, raw: m[1].trim(), unparsed: true });
  }
  let criteria = null; // plan: acceptance criteria (the journal keeps only the number of characters)
  if (protocol === 'plan') {
    const i = lines.findIndex((l) => /^ACCEPTANCE CRITERIA:/.test(l));
    if (i >= 0) {
      const j = lines.findIndex((l, k) => k > i && /^SUMMARY:/.test(l));
      criteria = lines.slice(i + 1, j < 0 ? lines.length : j).join('\n').trim() || null;
    }
  }
  return { state: 'ok', reason: null, verdict, controlLine: true, concerns, citations, summary: summaryRow.slice('SUMMARY:'.length).trim(), criteria, text: raw };
}

// Citation validator: every SOURCE citation is checked against the set of shown files and ranges from the input
// metadata (shown = { file: [[a,b],...] }). A citation that cannot be parsed is invalid (unparsed), not skipped.
function validateCitations(citations, shown) {
  const valid = []; const invalid = [];
  for (const c of Array.isArray(citations) ? citations : []) {
    if (c.unparsed || !c.file || !Number.isInteger(c.line) || c.line < 1) { invalid.push({ ...c, reason: 'unparsed' }); continue; }
    const ranges = (shown && typeof shown === 'object' ? shown : {})[c.file];
    if (!Array.isArray(ranges)) { invalid.push({ ...c, reason: 'file-not-shown' }); continue; }
    if (!ranges.some(([a, b]) => c.line >= a && c.line <= b)) { invalid.push({ ...c, reason: 'line-outside-shown' }); continue; }
    valid.push(c);
  }
  const total = valid.length + invalid.length;
  return { total, valid, invalid, message: `citation validation: ${valid.length} of ${total} valid` };
}

// Protective cap of the advice for the printout: the TOKEN and VERDICT lines are never trimmed; the rest is trimmed on
// whole lines with a trimming marker. Returns { text, trimmed }.
const MARKER_RESERVE = 96;
function capAdvice(text, cap) {
  const s = String(text ?? '');
  const limit = Number.isFinite(cap) && cap > 0 ? cap : Infinity;
  if (s.length <= limit) return { text: s, trimmed: false };
  const lines = s.split('\n');
  const verdictIndex = lines.findIndex((l) => /^VERDICT:/.test(l));
  const protectedCount = verdictIndex >= 0 ? verdictIndex + 1 : 1; // the TOKEN line (first) and the VERDICT line (with the text between them) are never trimmed
  const head = lines.slice(0, protectedCount).join('\n');
  let used = head.length + 1;
  const tail = [];
  for (let i = protectedCount; i < lines.length; i++) {
    if (used + lines[i].length + 1 > limit - MARKER_RESERVE) break;
    tail.push(lines[i]); used += lines[i].length + 1;
  }
  if (tail.length === lines.length - protectedCount) return { text: s, trimmed: false }; // it fit whole
  const marker = `[TRIMMED: further advice text over the protective cap of ${limit} characters]`;
  let result = [head, ...tail, marker].join('\n');
  if (result.length > limit && tail.length === 0) result = `${head}\n[TRIMMED: cap ${limit} characters]`; // an extremely small cap: a short marker, the protected lines untouched
  return { text: result, trimmed: true };
}

// Resolution per protocol (status: ok | no-advice | stale | invalid-citations | stop). Exit code 3 = the gate failed /
// no advice in the final profile; 0 = advice delivered (the advisory mode is always 0, fail-open). A STOP verdict in
// the final gate has its own status `stop` (exit code 3: the gate failed, advice delivered); a STOP without a valid
// SOURCE citation gets a warning (the item needs a STOP with citations). In the final profile an unknown state
// (stale === null) counts as STALE (exit code 3): the fail-closed gate does not pass on unknown data.
// stale: true/false from the comparison of the diff hash and HEAD (advisor script), null = unknown state.
function decide({ protocol, parsed, validation, stale }) {
  if (!parsed || parsed.state !== 'ok') {
    return protocol === 'final'
      ? { status: ADVISOR_STATUSES.NO_ADVICE, code: 3, advisory: false, warning: null }
      : { status: ADVISOR_STATUSES.NO_ADVICE, code: 0, advisory: true, warning: null };
  }
  if (protocol === 'final' && parsed.verdict === 'STOP') {
    const noCitations = validation.valid.length < 1 || validation.invalid.length > 0;
    return { status: ADVISOR_STATUSES.STOP, code: 3, advisory: true, warning: noCitations ? 'WARNING: STOP without a valid SOURCE citation or with an invalid citation; the final gate failed' : 'GATE: STOP; the final gate failed' };
  }
  if (protocol === 'final' && parsed.verdict === 'GO') {
    if (stale === true) return { status: ADVISOR_STATUSES.STALE, code: 3, advisory: false, warning: 'STATE: STALE, the files of the diff changed since the input; GO does not pass the final gate' };
    if (stale === null) return { status: ADVISOR_STATUSES.STALE, code: 3, advisory: false, warning: 'STATE: the diff cannot be compared (git unavailable or no worktree); the final gate is fail-closed: not passed' };
    if (validation.valid.length < 1 || validation.invalid.length > 0) return { status: ADVISOR_STATUSES.INVALID_CITATIONS, code: 3, advisory: false, warning: 'GATE: GO without a valid SOURCE citation or with an invalid citation does not pass the final gate' };
    return { status: ADVISOR_STATUSES.OK, code: 0, advisory: false, warning: null };
  }
  const warning = validation.invalid.length > 0
    ? validation.invalid.map((c) => `WARNING: invalid citation (${c.raw}: ${c.reason})`).join('\n')
    : null;
  return { status: ADVISOR_STATUSES.OK, code: 0, advisory: true, warning };
}

module.exports = { PROTOCOLS, VERDICTS, controlToken, parseProfiles, systemRole, parse, validateCitations, capAdvice, decide, ANNOUNCEMENT_THRESHOLD, ANNOUNCEMENT_PATTERN };
