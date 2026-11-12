// Reference implementation of the "output-trim" result trimmer (negative result, never wired into a hook; see
// docs/jev/negative-results/jev-compaction-experiments.md). Pure functions, used only by the counter next to it (../count-trim.mjs):
// nothing here calls a hook, writes a file or reaches a network. The measured gain stayed far below the 10 % threshold that was set
// before the measurement. Markers and footers are in Polish, as in the sessions it was written for.
//
// Pipeline (each step works on the output of the previous one):
//   1 ansi     terminal escape sequences and control characters are removed (no information for the model)
//   2 cr       carriage-return rewrites ("progress bars") are folded to the final visible state of the line
//   3 repeat   a run of >= 3 identical consecutive lines becomes the line once plus "(powtórzone N razy)"
//   4 success  a series of >= 8 consecutive success lines of one family (test passed, "Compiling", "Collecting", ...) keeps the first and
//              the last line; every line that mentions an error, warning or failure is never part of a series
//   5 long     a line longer than 2000 characters keeps its head and tail (marked, with the number of characters left out)
// Steps 1-2 lose nothing the model could use. Steps 3-5 are lossy, so the original goes to an archive file and the footer names it.

export const TRIM_MIN_CHARS = 4000; // results shorter than this are left alone
export const TRIM_MIN_NET_GAIN = 300; // do not rewrite a result unless at least this many characters are saved (footer included)
export const REPEAT_MIN = 3;
export const SUCCESS_SERIES_MIN = 8;
export const LONG_LINE_CHARS = 2000;
const LONG_KEEP = 700; // head and tail kept of a long line

export const ALL_KINDS = Object.freeze({ ansi: true, cr: true, repeat: true, success: true, long: true });

// ---------------------------------------------------------------- 1 + 2: terminal noise

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// Renders one line (no "\n" inside) the way a terminal would show it at the end: "\r" returns to column 0 and later text overwrites,
// "\b" steps back, CSI K erases, CSI G moves to a column, every other escape sequence and control character is dropped.
function renderLine(line, counts) {
  const out = [];
  let col = 0;
  const n = line.length;
  let i = 0;
  const put = (ch) => {
    if (col > out.length + 200) col = out.length + 200; // a hostile "ESC[999999999C" must not allocate a huge array
    while (out.length < col) out.push(' ');
    out[col++] = ch;
  };
  while (i < n) {
    const code = line.charCodeAt(i);
    if (code === 0x1b) {
      const next = line[i + 1];
      let j = i + 1;
      if (next === '[') {
        j = i + 2;
        while (j < n && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) j++;
        const paramEnd = j;
        while (j < n && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++;
        if (j < n && line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e) {
          const fin = line[j];
          const params = line.slice(i + 2, paramEnd);
          const num = params === '' ? NaN : parseInt(params, 10);
          if (fin === 'K') {
            if (params === '' || num === 0) out.length = Math.min(out.length, col);
            else if (num === 1) for (let k = 0; k < col && k < out.length; k++) out[k] = ' ';
            else if (num === 2) out.length = 0;
          } else if (fin === 'G') col = Math.max(0, (Number.isFinite(num) ? num : 1) - 1);
          else if (fin === 'C') col += Number.isFinite(num) ? num : 1;
          else if (fin === 'D') col = Math.max(0, col - (Number.isFinite(num) ? num : 1));
          j += 1;
        }
        // an unfinished sequence at the end of the line is dropped whole
      } else if (next === ']') {
        j = i + 2;
        while (j < n && line.charCodeAt(j) !== 0x07 && !(line.charCodeAt(j) === 0x1b && line[j + 1] === '\\')) j++;
        j = j < n ? (line.charCodeAt(j) === 0x07 ? j + 1 : j + 2) : n;
      } else if (next === '(' || next === ')' || next === '*' || next === '+') {
        j = Math.min(n, i + 3);
      } else if (next !== undefined) {
        j = i + 2;
      }
      counts.ansi += j - i;
      i = j;
      continue;
    }
    if (code === 0x0d) { col = 0; i++; continue; }
    if (code === 0x08) { col = Math.max(0, col - 1); i++; continue; }
    if (code < 0x20 && code !== 0x09) { counts.ansi += 1; i++; continue; }
    if (code === 0x7f) { counts.ansi += 1; i++; continue; }
    put(line[i]);
    i++;
  }
  return out.join('');
}

// Returns { text, ansi, cr }: characters taken out as escape sequences / control characters (ansi) and as overwritten text (cr).
export function stripTerminalNoise(text) {
  const result = { text, ansi: 0, cr: 0 };
  if (!CONTROL_RE.test(text)) return result;
  const lines = text.split('\n');
  const counts = { ansi: 0 };
  let changed = false;
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    if (!CONTROL_RE.test(line)) continue;
    const crlf = line.endsWith('\r');
    if (crlf) line = line.slice(0, -1);
    const before = counts.ansi;
    const rendered = renderLine(line, counts);
    const tail = crlf ? '\r' : '';
    if (rendered + tail !== lines[k]) {
      const lost = lines[k].length - (rendered.length + tail.length);
      const ansiHere = counts.ansi - before;
      result.cr += Math.max(0, lost - ansiHere);
      lines[k] = rendered + tail;
      changed = true;
    }
  }
  if (!changed) return result;
  result.text = lines.join('\n');
  result.ansi = counts.ansi;
  return result;
}

// ---------------------------------------------------------------- 3: repeated lines

export function collapseRepeats(text) {
  const lines = text.split('\n');
  const out = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= REPEAT_MIN && lines[i].trim() !== '') {
      const marker = `(powtórzone ${run} razy)`;
      const saved = (run - 1) * (lines[i].length + 1) - (marker.length + 1);
      if (saved > 0) {
        out.push(lines[i], marker);
        removed += saved;
        i = j;
        continue;
      }
    }
    for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return { text: removed > 0 ? out.join('\n') : text, removed };
}

// ---------------------------------------------------------------- 4: series of success lines

// A line that contains any of these (as a substring, so "HttpError" and "warnings" count; English and Polish) is never part of a series.
const PROBLEM_RE = /(?:fail|error|exception|traceback|panic|fatal|denied|deny|cannot|can't|unable|timeout|timed out|abort|critical|refus|invalid|unexpected|mismatch|deprecat|skipp|warn|xfail|xpass|not ok|problem|broken|crash|assert|todo|blocked|not found|no such|błąd|błęd|ostrzeż|niepowodz|nie udało|odmow|odrzuc|[✗✘×❌⚠]|^\s*E\s{2,})/i;

const SUCCESS_FAMILIES = [
  ['tick', /^\s*[✓✔√]/],
  ['pass-word', /^\s*(?:\[\s*(?:PASS|PASSED|OK)\s*\]|(?:PASS|PASSED|OK)(?:[:\s]|$))/],
  ['tap', /^\s*ok\s+\d+(?:\s|$)/],
  ['go', /^(?:ok\s{2,}\S+\s+[\d.]+s|---\s+PASS:|===\s+(?:RUN|PAUSE|CONT)\s)/],
  ['rust-test', /^test\s+\S+\s+\.\.\.\s+ok$/],
  ['pytest', /^(?:\S+::\S+\s+PASSED\b|[\w./\\-]+\.py\s+[.sx]+(?:\s+\[\s*\d+%\])?\s*$)/],
  ['pip', /^(?:Collecting |Downloading |Using cached |Requirement already satisfied|Obtaining |Preparing metadata|Building wheel|Created wheel|Stored in directory)/],
  ['cargo', /^\s*(?:Compiling|Downloading|Downloaded|Fresh|Checking|Documenting|Updating|Locking|Adding|Blocking|Packaging|Verifying)\s+\S+/],
  ['gradle', /^>\s+Task\s+:\S+(?:\s+(?:UP-TO-DATE|NO-SOURCE|FROM-CACHE))?\s*$/],
  ['apt', /^(?:Get:\d+|Hit:\d+|Ign:\d+|Selecting previously unselected package|Preparing to unpack|Unpacking |Setting up |Processing triggers for )/],
  ['docker-layer', /^(?:[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists)|#\d+ (?:CACHED|DONE [\d.]+s))$/],
  ['verbose-fileop', /^(?:'[^']+' -> '[^']+'|(?:removed|renamed|created directory) '.+'|VERBOSE: (?:Performing the operation|Copying|Moving).*)$/],
  ['generic-ok', /\s(?:\.\.\.\s*)?(?:ok|OK|passed|PASSED|done|DONE)$/],
];

function successFamily(raw) {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // CRLF output (Windows) must match the families that end with $
  if (line.length > 400 || PROBLEM_RE.test(line)) return null;
  for (const [name, re] of SUCCESS_FAMILIES) if (re.test(line)) return name;
  return null;
}

export function collapseSuccessSeries(text) {
  const lines = text.split('\n');
  const fam = lines.map(successFamily);
  const out = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    if (fam[i]) {
      let j = i + 1;
      while (j < lines.length && fam[j] === fam[i]) j++;
      const run = j - i;
      if (run >= SUCCESS_SERIES_MIN) {
        const middle = lines.slice(i + 1, j - 1);
        const marker = `[… pominięto ${middle.length} kolejnych linii sukcesu (${fam[i]}) …]`;
        const saved = middle.reduce((s, l) => s + l.length + 1, 0) - (marker.length + 1);
        if (saved > 0) {
          out.push(lines[i], marker, lines[j - 1]);
          removed += saved;
          i = j;
          continue;
        }
      }
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return { text: removed > 0 ? out.join('\n') : text, removed };
}

// ---------------------------------------------------------------- 5: long lines

export function shortenLongLines(text) {
  if (text.length <= LONG_LINE_CHARS) return { text, removed: 0 };
  const lines = text.split('\n');
  let removed = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.length <= LONG_LINE_CHARS) continue;
    const cut = line.length - 2 * LONG_KEEP;
    const marker = `[… ${cut} znaków pominięto …]`;
    const saved = cut - marker.length;
    if (saved < 400) continue;
    lines[k] = line.slice(0, LONG_KEEP) + marker + line.slice(line.length - LONG_KEEP);
    removed += saved;
  }
  return { text: removed > 0 ? lines.join('\n') : text, removed };
}

// ---------------------------------------------------------------- classification

const CONTENT_CMD_RE = /^(?:cat|head|tail|less|more|bat|type|get-content|gc|sed|awk|jq|yq|xxd|od|hexdump|diff|colordiff|ls|dir|tree|find|get-childitem|gci|grep|egrep|fgrep|rg|ag|select-string|sls|stat|readlink|realpath|column|strings|nl|tac|rev)$/i;
const GIT_CONTENT_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|show|blame|cat-file|format-patch|stash\s+show|log\s+[^|;&]*(?:-p|--patch|-u)\b)/;
const PS_CONTENT_RE = /\b(?:ConvertTo-Json|ConvertFrom-Json|Format-Table|Format-List|Out-String|Get-Content|Select-String)\b/i;

function firstCommandWord(command) {
  let s = String(command || '').trim();
  for (let guard = 0; guard < 8; guard++) {
    const m = s.match(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+|(?:sudo|time|command|exec|nohup)\s+|(?:timeout|nice)\s+(?:-\S+\s+)*\d*\s*|\(\s*|\{\s*)/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const tok = s.split(/[\s|;&<>]/)[0] || '';
  return tok.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

// Returns a reason string when the result is content the model asked for (file text, diff, JSON, directory listing, search hits): such
// results are never changed. Otherwise null.
export function contentReason(toolName, command, text) {
  const isShell = toolName === 'Bash' || toolName === 'PowerShell';
  if (isShell) {
    const word = firstCommandWord(command);
    if (CONTENT_CMD_RE.test(word)) return 'reader-command';
    if (GIT_CONTENT_RE.test(String(command || ''))) return 'git-content';
    if (toolName === 'PowerShell' && PS_CONTENT_RE.test(String(command || ''))) return 'ps-content';
  }
  const head = text.length > 6000 ? text.slice(0, 6000) : text;
  if (/^diff --git |^@@ -\d+(?:,\d+)? \+\d+|^--- \S+\r?\n\+\+\+ \S+/m.test(head)) return 'diff';
  const t = text.trim();
  if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
  }
  return null;
}

const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
];
// JWT: at most 50 candidates, each tested on a bounded slice (a plain regex over "-eyJ-eyJ-..." was quadratic).
function hasJwt(text) {
  let from = 0;
  for (let k = 0; k < 50; k++) {
    const i = text.indexOf('eyJ', from);
    if (i < 0) return false;
    if (/^eyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}/.test(text.slice(i, i + 12300))) return true;
    from = i + 3;
  }
  return false;
}
export function looksLikeSecret(text) {
  for (const re of SECRET_RES) if (re.test(text)) return true;
  return hasJwt(text);
}

// Directory names whose results are never trimmed (the original list named three private work folders; here the names are a placeholder).
const PRIVATE_RE = /(?:^|[\\/])(?:private|confidential)(?:[\\/]|$)/i;
export function mentionsPrivateDir(...values) {
  for (const v of values) if (typeof v === 'string' && PRIVATE_RE.test(v)) return true;
  return false;
}

// ---------------------------------------------------------------- main entry

export function buildFooter(saved, kinds, archivePath) {
  const what = [kinds.repeat > 0 ? 'powtórzenia' : null, kinds.success > 0 ? 'linie sukcesu' : null, kinds.long > 0 ? 'długie linie' : null].filter(Boolean).join(', ');
  const tail = archivePath ? `pełny wynik: ${archivePath}` : 'pełnego wyniku brak (wynik wygląda na poufny), uruchom polecenie ponownie';
  return `[odszumiono: ${saved} znaków (${what}); ${tail}]`;
}

// text: the result text as the model would see it. Options:
//   content   reason string from contentReason() or null (content: nothing is changed)
//   enable    which steps run (default all)
//   archivePath  where the caller will store the original (null: no archive, footer says "uruchom ponownie")
//   minChars, minNetGain  policy thresholds
// Returns { text, before, after, saved, applied, lossy, kinds, reason }. `kinds` holds the raw characters each step took out (before the
// policy decision); `saved` is the net saving after the policy and the footer (0 when not applied).
export function trimText(text, opts = {}) {
  const enable = { ...ALL_KINDS, ...(opts.enable || {}) };
  const before = text.length;
  const kinds = { ansi: 0, cr: 0, repeat: 0, success: 0, long: 0 };
  const res = { text, before, after: before, saved: 0, applied: false, lossy: false, kinds, reason: null };
  if (before < (opts.minChars ?? TRIM_MIN_CHARS)) { res.reason = 'short'; return res; }
  if (opts.content) { res.reason = `content:${opts.content}`; return res; }
  let cur = text;
  if (enable.ansi || enable.cr) {
    const t = stripTerminalNoise(cur);
    if (enable.ansi) kinds.ansi = t.ansi;
    if (enable.cr) kinds.cr = t.cr;
    cur = t.text;
  }
  if (enable.repeat) { const r = collapseRepeats(cur); kinds.repeat = r.removed; cur = r.text; }
  if (enable.success) { const r = collapseSuccessSeries(cur); kinds.success = r.removed; cur = r.text; }
  if (enable.long) { const r = shortenLongLines(cur); kinds.long = r.removed; cur = r.text; }
  const lossy = kinds.repeat + kinds.success + kinds.long > 0;
  let out = cur;
  if (lossy) {
    const footerBase = buildFooter(before - cur.length, kinds, opts.archivePath ?? null);
    out = cur + (cur.endsWith('\n') ? '' : '\n') + footerBase;
  }
  const net = before - out.length;
  res.lossy = lossy;
  if (net < (opts.minNetGain ?? TRIM_MIN_NET_GAIN)) { res.reason = 'below-gain'; return res; }
  res.text = out;
  res.after = out.length;
  res.saved = net;
  res.applied = true;
  return res;
}
