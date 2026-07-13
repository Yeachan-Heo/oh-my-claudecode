#!/usr/bin/env node
/**
 * OMC Workflow Drift Guard Stop hook.
 *
 * Boundary source: https://code.claude.com/docs/en/hooks documents Stop
 * hooks with last_assistant_message and decision:"block";
 * https://code.claude.com/docs/en/plugins-reference documents plugin
 * hooks/hooks.json loading and the shared lifecycle events.
 * This guard uses only deterministic Stop-hook signals and intentionally
 * fails open for ambiguous/free-form cases.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
const { readStdin } = await import(new URL('./lib/stdin.mjs', import.meta.url));

const HOOK_NAME = 'workflow-drift-guard';
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.sh', '.bash', '.zsh', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp']);
const COMPLETION_CLAIM_RE = /\b(?:done|complete[sd]?|finished|implemented|fixed|resolved|all set|ready\s+(?:for\s+(?:review|merge|release|qa|testing)|to\s+(?:merge|ship|release|submit)))\b/i;
const WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const NAME_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/+:-]*$/;
const RESERVED_CANDIDATES = new Set(['this', 'that', 'it', 'something', 'yes', 'no', 'not']);
const BARE_BINARY_REJECTED = new Set(['please', 'pick', 'choose', 'select', 'use', 'can', 'could', 'do', 'does', 'is', 'are', 'should', 'would', 'will', 'which', 'what', 'who', 'where', 'when', 'why', 'how']);
const ACTION_AUXILIARIES = new Set(['am', 'are', 'be', 'been', 'being', 'can', 'could', 'did', 'do', 'does', 'had', 'has', 'have', 'is', 'may', 'might', 'must', 'shall', 'should', 'was', 'were', 'will', 'would']);
const LIVENESS_STATUSES = ['ruled out', 'eliminated', 'discarded', 'not viable', 'no longer an option', 'already chosen', 'already selected', 'already resolved'];
const CARDINALITY_STATUSES = ['ruled out', 'eliminated', 'discarded', 'not viable', 'no longer an option', 'resolved', 'already chosen', 'already selected', 'already resolved'];
const LIST_STATUSES = ['ruled out', 'eliminated', 'discarded', 'not viable', 'no longer an option'];
const SELECTION_CLOSERS = new Set([
  'which option should i choose?',
  'which option should i use?',
  'which option should i take?',
  'which approach should i choose?',
  'which approach should i use?',
  'which approach should i take?',
  'which path should i choose?',
  'which path should i use?',
  'which path should i take?',
  'which one should i choose?',
  'which one should i use?',
  'which one should i take?',
  'which should i choose?',
  'which should i use?',
  'which should i take?',
]);
const BLOCKER_PATTERNS = [
  { kind: 'skipped test', pattern: /\b(?:it|test|describe)\.skip\s*\(/i },
  { kind: 'focused test', pattern: /\b(?:it|test|describe)\.only\s*\(/i },
  { kind: 'placeholder TODO', pattern: /\bTODO\b(?:\([^)]*\))?\s*:?\s*(?:implement|fix|replace|stub|placeholder|later|follow[- ]?up|wire|add\b|fill)/i },
  { kind: 'unimplemented throw', pattern: /throw\s+new\s+Error\s*\(\s*["'`](?:TODO|Not implemented|unimplemented|stub)/i },
  { kind: 'placeholder return', pattern: /\breturn\s+(?:null|undefined)\s*;?\s*\/\/\s*(?:TODO|stub|placeholder|not implemented)/i },
  { kind: 'placeholder implementation', pattern: /\b(?:stub|placeholder|not implemented|unimplemented)\s+(?:implementation|branch|path|test|coverage)\b/i },
];

function skippedByEnv() {
  if (process.env.DISABLE_OMC === '1' || process.env.DISABLE_OMC === 'true') return true;
  return (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim()).includes(HOOK_NAME);
}

function safeJsonParse(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function lastAssistantMessage(input) {
  if (input && Object.prototype.hasOwnProperty.call(input, 'last_assistant_message')) {
    const canonical = input.last_assistant_message;
    return typeof canonical === 'string' ? canonical.trim() : '';
  }
  for (const key of ['lastAssistantMessage', 'message', 'output', 'response', 'text']) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isCodePath(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch { return ''; }
}

function changedCodePaths(cwd) {
  const names = new Set();
  for (const line of git(cwd, ['diff', '--name-only', 'HEAD', '--']).split('\n')) {
    const path = line.trim();
    if (path && isCodePath(path)) names.add(path);
  }
  for (const line of git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const path = line.trim();
    if (path && isCodePath(path)) names.add(path);
  }
  return [...names];
}

function addedLinesForPath(cwd, path) {
  const diff = git(cwd, ['diff', '--unified=0', 'HEAD', '--', path]);
  if (diff) {
    const added = [];
    let newLine = 0;
    for (const line of diff.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number.parseInt(hunk[1], 10);
        continue;
      }
      if (line.startsWith('+++') || line.startsWith('---') || newLine === 0) continue;
      if (line.startsWith('+')) {
        added.push({ lineNumber: newLine, text: line.slice(1) });
        newLine += 1;
      } else if (!line.startsWith('-')) {
        newLine += 1;
      }
    }
    return added;
  }
  const fullPath = join(cwd, path);
  if (!existsSync(fullPath)) return [];
  try {
    return readFileSync(fullPath, 'utf8')
      .split('\n')
      .map((text, index) => ({ lineNumber: index + 1, text }));
  } catch { return []; }
}

function stripQuotedAndRegexLiterals(line) {
  let result = '';
  let quote = '';
  let escaped = false;
  let inRegex = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const prev = line[index - 1] || '';
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      result += ' ';
      continue;
    }
    if (inRegex) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '/') {
        inRegex = false;
      }
      result += ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      result += ' ';
      continue;
    }
    if (char === '/' && prev !== '/' && prev !== '*' && /[=(:,\[]/.test(prev.trim() || '=')) {
      inRegex = true;
      result += ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function blockerScanText(text) {
  const stripped = stripQuotedAndRegexLiterals(text);
  const commentIndex = stripped.indexOf('//');
  if (commentIndex >= 0) return stripped.slice(commentIndex);
  return stripped;
}

function findCompletionBlockers(cwd) {
  const blockers = [];
  for (const path of changedCodePaths(cwd)) {
    const lines = addedLinesForPath(cwd, path);
    lines.forEach(({ lineNumber, text }) => {
      const scanText = blockerScanText(text);
      for (const { kind, pattern } of BLOCKER_PATTERNS) {
        if (pattern.test(scanText)) {
          blockers.push({ path, line: lineNumber, kind, text: text.trim().slice(0, 160) });
          break;
        }
      }
    });
  }
  return blockers.slice(0, 8);
}

function isAsciiWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function trimAscii(value) {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

function lineEndAt(text, start) {
  const nextNewline = text.indexOf('\n', start);
  return nextNewline === -1 ? text.length : nextNewline;
}

function maskDecisionNoise(message) {
  const chars = message.split('');
  const uncertainties = [];

  function maskRange(start, end) {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }

  function addUncertainty(start, end, reason) {
    uncertainties.push({ start, end, reason });
  }

  function runLength(start, character) {
    let end = start;
    while (message[end] === character) end += 1;
    return end - start;
  }

  function findFenceClose(start, character, minimumLength) {
    for (let index = start; index < message.length; index += 1) {
      if (message[index] === character && runLength(index, character) >= minimumLength) return index;
    }
    return -1;
  }

  function findInlineClose(start, delimiter) {
    for (let index = start; index < message.length; index += 1) {
      if (message.startsWith(delimiter, index)) return index;
    }
    return -1;
  }

  function findQuoteClose(start, quote) {
    let escaped = false;
    for (let index = start; index < message.length; index += 1) {
      const character = message[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        return index;
      }
    }
    return -1;
  }

  function isRegexStart(index) {
    let previous = index - 1;
    while (previous >= 0 && (message[previous] === ' ' || message[previous] === '\t')) previous -= 1;
    if (previous < 0) return false;
    if ('=([{:,'.includes(message[previous])) return true;
    return /\breturn$/.test(message.slice(0, previous + 1));
  }

  function findRegexClose(start, lineEnd) {
    let escaped = false;
    let inCharacterClass = false;
    for (let index = start; index < lineEnd; index += 1) {
      const character = message[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '[') {
        inCharacterClass = true;
      } else if (character === ']') {
        inCharacterClass = false;
      } else if (character === '/' && !inCharacterClass) {
        return index;
      }
    }
    return -1;
  }

  function ternaryExpressionStart(index, lineStart) {
    const before = message.slice(lineStart, index).replace(/[ \t]+$/, '');
    const match = before.match(/([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^()]*\))*)$/);
    if (!match || match.index === undefined) return -1;
    const expressionStart = lineStart + match.index;
    let previous = expressionStart - 1;
    while (previous >= lineStart && (message[previous] === ' ' || message[previous] === '\t')) previous -= 1;
    if (previous < lineStart) return expressionStart;
    if ('=;([{,:'.includes(message[previous])) return expressionStart;
    return /\b(?:return|const|let|var)$/.test(message.slice(lineStart, previous + 1)) ? expressionStart : -1;
  }

  for (let index = 0; index < message.length;) {
    if (index === 0 || message[index - 1] === '\n') {
      let firstToken = index;
      while (message[firstToken] === ' ' || message[firstToken] === '\t') firstToken += 1;
      if (message[firstToken] === '>') {
        const end = lineEndAt(message, index);
        maskRange(index, end);
        index = end;
        continue;
      }
    }

    const character = message[index];
    if ((character === '`' || character === '~') && runLength(index, character) >= 3) {
      const length = runLength(index, character);
      const close = findFenceClose(index + length, character, length);
      if (close >= 0) {
        maskRange(index, close + runLength(close, character));
        index = close + runLength(close, character);
      } else {
        maskRange(index, message.length);
        addUncertainty(index, message.length, 'unclosed-fence');
        break;
      }
      continue;
    }

    if (character === '`') {
      const length = runLength(index, '`');
      const delimiter = '`'.repeat(length);
      const close = findInlineClose(index + length, delimiter);
      if (close >= 0) {
        maskRange(index, close + length);
        index = close + length;
      } else {
        maskRange(index, message.length);
        addUncertainty(index, message.length, 'unclosed-inline-code');
        break;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      const previous = message[index - 1] || '';
      const next = message[index + 1] || '';
      if (character === "'" && /[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next)) {
        index += 1;
        continue;
      }
      const close = findQuoteClose(index + 1, character);
      if (close >= 0) {
        maskRange(index, close + 1);
        index = close + 1;
      } else {
        maskRange(index, message.length);
        addUncertainty(index, message.length, 'unclosed-quote');
        break;
      }
      continue;
    }

    if (character === '‘' || character === '“') {
      const closeCharacter = character === '‘' ? '’' : '”';
      const close = message.indexOf(closeCharacter, index + 1);
      if (close >= 0) {
        maskRange(index, close + 1);
        index = close + 1;
      } else {
        maskRange(index, message.length);
        addUncertainty(index, message.length, 'unclosed-quote');
        break;
      }
      continue;
    }

    if (character === '/' && isRegexStart(index)) {
      const lineEnd = lineEndAt(message, index);
      const close = findRegexClose(index + 1, lineEnd);
      if (close >= 0) {
        let end = close + 1;
        while (/[A-Za-z]/.test(message[end] || '')) end += 1;
        maskRange(index, end);
        index = end;
      } else {
        maskRange(index, lineEnd);
        addUncertainty(index, lineEnd, 'ambiguous-regex');
        index = lineEnd;
      }
      continue;
    }

    if (character === '?') {
      const lineStart = message.lastIndexOf('\n', index - 1) + 1;
      const lineEnd = lineEndAt(message, index);
      const expressionStart = ternaryExpressionStart(index, lineStart);
      const codeContext = /\b(?:const|let|var|return)\b|=|;/.test(message.slice(lineStart, lineEnd));
      if (expressionStart >= 0 && codeContext) {
        const colon = message.indexOf(':', index + 1);
        if (colon >= 0 && colon < lineEnd) {
          maskRange(expressionStart, lineEnd);
          index = lineEnd;
        } else {
          maskRange(index, lineEnd);
          addUncertainty(index, lineEnd, 'malformed-ternary');
          index = lineEnd;
        }
        continue;
      }
    }

    index += 1;
  }

  return { masked: chars.join(''), uncertainties };
}

function isSentenceBoundaryAt(text, index) {
  const character = text[index];
  if (character === '\n' || character === '!' || character === '?') return true;
  if (character !== '.') return false;
  return !/[A-Za-z0-9._/+:-]/.test(text[index - 1] || '')
    || !/[A-Za-z0-9._/+:-]/.test(text[index + 1] || '');
}

function extractClosingQuestion(masked, original) {
  let end = masked.length;
  while (true) {
    const previousEnd = end;
    while (end > 0 && isAsciiWhitespace(masked[end - 1])) end -= 1;
    while (end > 0 && [')', ']', '}', '"', "'", '`'].includes(masked[end - 1])) end -= 1;
    if (end === previousEnd) break;
  }
  if (end === 0 || masked[end - 1] !== '?') return null;

  const questionEnd = end;
  let questionStart = 0;
  for (let index = questionEnd - 2; index >= 0; index -= 1) {
    if (isSentenceBoundaryAt(masked, index)) {
      questionStart = index + 1;
      break;
    }
  }
  while (questionStart < questionEnd && isAsciiWhitespace(masked[questionStart])) questionStart += 1;
  const text = trimAscii(masked.slice(questionStart, questionEnd));
  if (!text.endsWith('?')) return null;
  return {
    text,
    start: questionStart,
    end: questionEnd,
    source: original.slice(questionStart, questionEnd),
  };
}
function hasAmbiguousPreviousLine(masked, question) {
  const lineStart = masked.lastIndexOf('\n', question.start - 1) + 1;
  if (lineStart === 0) return false;
  const previousLineEnd = lineStart - 1;
  const previousLineStart = masked.lastIndexOf('\n', previousLineEnd - 1) + 1;
  const previousLine = trimAscii(masked.slice(previousLineStart, previousLineEnd));
  return previousLine !== '' && !/[.!?]$/.test(previousLine);
}


function stripBalancedOuterEmphasis(value) {
  const pairs = [['**', '**'], ['__', '__'], ['*', '*'], ['_', '_']];
  for (const [opening, closing] of pairs) {
    if (value.startsWith(opening) && value.endsWith(closing) && value.length > opening.length + closing.length) {
      return value.slice(opening.length, -closing.length);
    }
  }
  return value;
}

function normalizeCandidate(raw) {
  let value = trimAscii(raw);
  value = stripBalancedOuterEmphasis(value);
  value = trimAscii(value).replace(/^[*_~()[\]{}.,:;!]+|[*_~()[\]{}.,:;!]+$/g, '');
  value = value.replace(/[ \t\r\n]+/g, ' ');
  value = value.replace(/^(?:a|an|the) /i, '');
  return value.toLowerCase();
}

function classifyCandidate(raw) {
  const normalized = normalizeCandidate(raw);
  const escape = normalized === 'other' || normalized === 'other/free-form';
  return {
    raw,
    normalized,
    substantive: normalized !== '' && !RESERVED_CANDIDATES.has(normalized) && !escape,
    liveness: 'live',
    escape,
  };
}

function classifyCandidateLiveness(status) {
  return LIVENESS_STATUSES.includes(status.toLowerCase()) ? 'eliminated' : 'unknown';
}

function collapseCandidateIdentities(candidates) {
  const identities = new Map();
  let unknown = false;
  for (const candidate of candidates) {
    if (candidate.liveness === 'unknown') unknown = true;
    const previous = identities.get(candidate.normalized);
    if (!previous) {
      identities.set(candidate.normalized, { ...candidate });
      continue;
    }
    if (previous.substantive !== candidate.substantive || previous.liveness !== candidate.liveness) {
      unknown = true;
    }
  }
  return { candidates: [...identities.values()], unknown };
}

function hasRelevantUncertainty(record, uncertainties) {
  return uncertainties.some(uncertainty => uncertainty.end > record.contextStart);
}

function hasExplicitFreeFormEscape(record) {
  return record.freeForm === true || record.candidates.some(candidate => candidate.escape);
}

function isWordSequence(value, minimum, maximum) {
  const tokens = value.split(' ');
  return tokens.length >= minimum && tokens.length <= maximum && tokens.every(token => WORD_RE.test(token));
}

function countTopLevelOr(value) {
  const positions = [];
  for (let index = value.indexOf(' or '); index >= 0; index = value.indexOf(' or ', index + 1)) positions.push(index);
  return positions;
}

function makeCandidateRecord(source, question, candidates) {
  return {
    source,
    subtype: 'named-candidates',
    contextStart: question.start,
    contextEnd: question.end,
    questionStart: question.start,
    questionEnd: question.end,
    intent: source === 'binary-question' ? 'binary-interrogative' : 'selection-question',
    candidates,
    cardinality: null,
    unknown: false,
    freeForm: false,
  };
}

function buildBinaryQuestionEvidence(question) {
  const body = question.text.slice(0, -1);
  const records = [];

  function parseOperands(value, minimum, maximum) {
    const delimiters = countTopLevelOr(value);
    if (delimiters.length !== 1) return null;
    const left = value.slice(0, delimiters[0]);
    const right = value.slice(delimiters[0] + 4);
    if (!left || !right || left.includes(' and ') || right.includes(' and ')) return null;
    if (!isWordSequence(left, minimum, maximum) || !isWordSequence(right, minimum, maximum)) return null;
    return { left, right };
  }

  const bare = parseOperands(body, 1, 1);
  if (bare) {
    const normalizedLeft = normalizeCandidate(bare.left);
    const normalizedRight = normalizeCandidate(bare.right);
    if (!BARE_BINARY_REJECTED.has(normalizedLeft) && !BARE_BINARY_REJECTED.has(normalizedRight)) {
      records.push(makeCandidateRecord('binary-question', question, [classifyCandidate(bare.left), classifyCandidate(bare.right)]));
    }
  }

  const namedPrefix = body.match(/^(?:Would you prefer|Do you prefer) (.+)$/i);
  if (namedPrefix) {
    const operands = parseOperands(namedPrefix[1], 1, 6);
    if (operands) {
      records.push(makeCandidateRecord('binary-question', question, [classifyCandidate(operands.left), classifyCandidate(operands.right)]));
    }
  }

  const actionPrefix = body.match(/^Should I (.+)$/i);
  if (actionPrefix) {
    const operands = parseOperands(actionPrefix[1], 1, 8);
    if (operands) {
      const leftCandidate = classifyCandidate(operands.left);
      const rightCandidate = classifyCandidate(operands.right);
      const leftWords = leftCandidate.normalized.split(' ');
      const rightWords = rightCandidate.normalized.split(' ');
      const polarity = leftCandidate.normalized === `not ${rightCandidate.normalized}`
        || rightCandidate.normalized === `not ${leftCandidate.normalized}`
        || leftCandidate.normalized.replace(/^not /, '') === rightCandidate.normalized.replace(/^not /, '')
        || ACTION_AUXILIARIES.has(leftWords[0])
        || ACTION_AUXILIARIES.has(rightWords[0]);
      if (!polarity) records.push(makeCandidateRecord('binary-question', question, [leftCandidate, rightCandidate]));
    }
  }

  return records.length === 1 ? records[0] : null;
}

function isNamedSetupCandidate(value) {
  const unwrapped = trimAscii(stripBalancedOuterEmphasis(trimAscii(value)));
  const tokens = unwrapped.split(' ');
  return tokens.length >= 1 && tokens.length <= 4 && tokens.every(token => NAME_TOKEN_RE.test(token));
}

function parseNamedSetupEnumeration(core) {
  const parses = [];
  for (let delimiter = core.indexOf(' and '); delimiter >= 0; delimiter = core.indexOf(' and ', delimiter + 1)) {
    const candidates = [core.slice(0, delimiter), core.slice(delimiter + 5)];
    if (candidates.every(isNamedSetupCandidate)) parses.push(candidates);
  }

  const three = core.match(/^(.+), (.+), and (.+)$/);
  if (three && three.slice(1).every(isNamedSetupCandidate)) parses.push(three.slice(1));

  const four = core.match(/^(.+), (.+), (.+), and (.+)$/);
  if (four && four.slice(1).every(isNamedSetupCandidate)) parses.push(four.slice(1));

  return parses.length === 1 ? parses[0] : null;
}

function parseEnumerationWithSuffix(value) {
  const suffixes = ['are viable options', 'are viable', 'are options', 'were considered'];
  const parses = [];
  for (const suffix of suffixes) {
    const ending = ` ${suffix}`;
    if (!value.toLowerCase().endsWith(ending)) continue;
    const candidates = parseNamedSetupEnumeration(value.slice(0, -ending.length));
    if (candidates) parses.push(candidates);
  }
  return parses.length === 1 ? parses[0] : null;
}


function parseLivenessClause(value) {
  for (const status of LIVENESS_STATUSES) {
    for (const copula of [' is ', ' was ']) {
      if (!value.toLowerCase().endsWith(`${copula}${status}`)) continue;
      const candidate = value.slice(0, -`${copula}${status}`.length);
      if (isNamedSetupCandidate(candidate)) return { candidate, status };
    }
  }
  return null;
}

function parseLivenessSequence(value) {
  const parses = [];
  const single = parseLivenessClause(value);
  if (single) parses.push([single]);
  for (let delimiter = value.indexOf(' and '); delimiter >= 0; delimiter = value.indexOf(' and ', delimiter + 1)) {
    const left = parseLivenessClause(value.slice(0, delimiter));
    const right = parseLivenessClause(value.slice(delimiter + 5));
    if (left && right) parses.push([left, right]);
  }
  return parses.length === 1 ? parses[0] : null;
}

function buildNamedSetupRecord(setup, question) {
  if (!setup.text.endsWith('.')) return null;
  const sentence = setup.text.slice(0, -1);
  let enumerationText = sentence;
  let suffix = null;

  const semicolon = sentence.indexOf('; ');
  if (semicolon >= 0) {
    if (semicolon !== sentence.lastIndexOf('; ')) return null;
    enumerationText = sentence.slice(0, semicolon);
    suffix = { type: 'semicolon', value: sentence.slice(semicolon + 2) };
  } else {
    const freeFormMatches = [];
    for (let delimiter = sentence.indexOf(', or '); delimiter >= 0; delimiter = sentence.indexOf(', or ', delimiter + 1)) {
      freeFormMatches.push({
        enumerationText: sentence.slice(0, delimiter),
        value: sentence.slice(delimiter + 5),
      });
    }
    if (freeFormMatches.length > 0) {
      const valid = freeFormMatches.filter(match => parseEnumerationWithSuffix(match.enumerationText));
      if (valid.length !== 1) return null;
      enumerationText = valid[0].enumerationText;
      suffix = { type: 'free-form', value: valid[0].value };
    }
  }

  const rawCandidates = parseEnumerationWithSuffix(enumerationText);
  if (!rawCandidates) return null;
  const record = {
    ...makeCandidateRecord('adjacent-setup', question, rawCandidates.map(classifyCandidate)),
    contextStart: setup.start,
    contextEnd: question.end,
  };

  if (!suffix) return record;
  if (suffix.type === 'free-form') {
    const freeForm = suffix.value.match(/^(?:paste|provide|enter) the exact (.+)$/i)
      || suffix.value.match(/^describe (.+)$/i);
    if (!freeForm || !isWordSequence(freeForm[1], 1, 6)) return null;
    record.freeForm = true;
    return record;
  }

  if (suffix.value.toLowerCase() === 'the other module is unchanged') return record;

  const only = suffix.value.match(/^only (.+) remains$/i);
  if (only && isNamedSetupCandidate(only[1])) {
    const attached = record.candidates.filter(candidate => candidate.normalized === normalizeCandidate(only[1]));
    if (attached.length !== 1) {
      record.unknown = true;
      return record;
    }
    for (const candidate of record.candidates) candidate.liveness = candidate === attached[0] ? 'live' : 'eliminated';
    return record;
  }

  const clauses = parseLivenessSequence(suffix.value);
  if (!clauses) return null;
  for (const clause of clauses) {
    const attached = record.candidates.filter(candidate => candidate.normalized === normalizeCandidate(clause.candidate));
    if (attached.length !== 1) {
      record.unknown = true;
      continue;
    }
    attached[0].liveness = classifyCandidateLiveness(clause.status);
  }
  return record;
}

function classifyCardinality(setup, question) {
  const sentence = setup.text.toLowerCase();
  const nounPairs = new Map([['paths', 'path'], ['options', 'option'], ['approaches', 'approach']]);
  let minimumLiveCount = null;
  let phrase = null;

  for (const [plural] of nounPairs) {
    for (const prefix of ['i found', 'there are']) {
      const exact = `${prefix} two viable ${plural}.`;
      if (sentence === exact) {
        minimumLiveCount = 2;
        phrase = `two viable ${plural}`;
      }
    }
    if (sentence === `two viable ${plural} remain.`) {
      minimumLiveCount = 2;
      phrase = `two viable ${plural}`;
    }
  }

  for (const [plural, singular] of nounPairs) {
    for (const prefix of ['i found', 'there are']) {
      for (const copula of ['is', 'was']) {
        for (const status of CARDINALITY_STATUSES) {
          if (sentence === `${prefix} two viable ${plural}, but one ${singular} ${copula} ${status}.`) {
            minimumLiveCount = 'unknown';
            phrase = `two viable ${plural}`;
          }
          if (sentence === `one ${singular} ${copula} ${status}; two viable ${plural} remain.`) {
            minimumLiveCount = 2;
            phrase = `two viable ${plural}`;
          }
        }
      }
    }
  }

  if (minimumLiveCount === null) return null;
  return {
    source: 'adjacent-setup',
    subtype: 'cardinality',
    contextStart: setup.start,
    contextEnd: question.end,
    questionStart: question.start,
    questionEnd: question.end,
    intent: 'selection-question',
    candidates: [],
    cardinality: { phrase, start: setup.start, end: setup.start + phrase.length, minimumLiveCount },
    unknown: minimumLiveCount === 'unknown',
    freeForm: false,
  };
}

function extractAdjacentSetup(masked, question) {
  let setupEnd = question.start;
  while (setupEnd > 0 && isAsciiWhitespace(masked[setupEnd - 1])) setupEnd -= 1;
  if (setupEnd === 0 || masked[setupEnd - 1] !== '.') return null;
  let setupStart = 0;
  for (let index = setupEnd - 2; index >= 0; index -= 1) {
    if (isSentenceBoundaryAt(masked, index)) {
      setupStart = index + 1;
      break;
    }
  }
  while (setupStart < setupEnd && isAsciiWhitespace(masked[setupStart])) setupStart += 1;
  const text = trimAscii(masked.slice(setupStart, setupEnd));
  return text ? { start: setupStart, end: setupEnd, text } : null;
}

function buildAdjacentSetupEvidence(masked, question) {
  if (!SELECTION_CLOSERS.has(question.text.toLowerCase())) return null;
  const setup = extractAdjacentSetup(masked, question);
  if (!setup) return null;
  const records = [buildNamedSetupRecord(setup, question), classifyCardinality(setup, question)].filter(Boolean);
  return records.length === 1 ? records[0] : null;
}

function parseListItem(line) {
  const marker = line.match(/^(?:- |\* |\+ |[1-9]\. |[A-Za-z]\. )/);
  if (!marker) return null;
  let body = line.slice(marker[0].length);
  let status = null;
  for (const candidateStatus of LIST_STATUSES) {
    const emDashSuffix = ` — ${candidateStatus}`;
    const parentheticalSuffix = ` (${candidateStatus})`;
    if (body.toLowerCase().endsWith(emDashSuffix)) {
      body = body.slice(0, -emDashSuffix.length);
      status = candidateStatus;
      break;
    }
    if (body.toLowerCase().endsWith(parentheticalSuffix)) {
      body = body.slice(0, -parentheticalSuffix.length);
      status = candidateStatus;
      break;
    }
  }
  if (!isWordSequence(body, 1, 8)) return { invalid: true };
  return { body, status };
}

function buildOptionListEvidence(masked, question) {
  if (!SELECTION_CLOSERS.has(question.text.toLowerCase())) return null;
  const questionLineStart = masked.lastIndexOf('\n', question.start - 1) + 1;
  let lineEnd = questionLineStart - 1;
  if (lineEnd < 0) return null;
  const items = [];
  let sawBlank = false;

  while (lineEnd >= 0) {
    const lineStart = masked.lastIndexOf('\n', lineEnd - 1) + 1;
    const line = masked.slice(lineStart, lineEnd);
    if (trimAscii(line) === '') {
      if (items.length === 0) return null;
      sawBlank = true;
    } else {
      const item = parseListItem(line);
      if (!item) {
        sawBlank = false;
        break;
      }
      if (item.invalid) return null;
      items.unshift({ ...item, start: lineStart });
      sawBlank = false;
    }
    lineEnd = lineStart - 1;
  }
  if (lineEnd < 0) sawBlank = false;

  if (items.length < 2 || sawBlank) return null;
  const record = {
    ...makeCandidateRecord('option-list', question, items.map(item => classifyCandidate(item.body))),
    contextStart: items[0].start,
    contextEnd: question.end,
  };
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].status) record.candidates[index].liveness = 'eliminated';
  }
  return record;
}

function isBlockingDecisionEvidence(record, uncertainties) {
  if (record.unknown || hasRelevantUncertainty(record, uncertainties)) return false;
  if (hasExplicitFreeFormEscape(record)) return false;
  if (record.cardinality) return record.cardinality.minimumLiveCount === 2;

  const collapsed = collapseCandidateIdentities(record.candidates);
  if (collapsed.unknown) return false;
  const liveCandidates = collapsed.candidates.filter(candidate => candidate.substantive && candidate.liveness === 'live');
  return liveCandidates.length >= 2;
}

function shouldBlockStructuredDecision(message) {
  const { masked, uncertainties } = maskDecisionNoise(message);
  const question = extractClosingQuestion(masked, message);
  if (!question) return false;
  let binaryRecord = buildBinaryQuestionEvidence(question);
  if (binaryRecord && hasAmbiguousPreviousLine(masked, question)) binaryRecord = null;
  const records = [
    binaryRecord,
    buildAdjacentSetupEvidence(masked, question),
    buildOptionListEvidence(masked, question),
  ].filter(Boolean);
  if (records.length !== 1) return false;
  return isBlockingDecisionEvidence(records[0], uncertainties);
}

function makeBlock(reason) {
  return { decision: 'block', reason };
}

async function main() {
  if (skippedByEnv()) {
    console.log(JSON.stringify({ suppressOutput: true }));
    return;
  }
  const input = safeJsonParse(await readStdin());
  // Claude Code docs warn Stop hooks receive stop_hook_active while already
  // continuing from a Stop hook; fail open to avoid self-reinforcing loops.
  if (input.stop_hook_active === true || input.stopHookActive === true) {
    console.log(JSON.stringify({ suppressOutput: true }));
    return;
  }

  const message = lastAssistantMessage(input);
  if (shouldBlockStructuredDecision(message)) {
    console.log(JSON.stringify(makeBlock('[WORKFLOW DRIFT GUARD] The final response contains a supported local selection fork that should be asked with structured AskUserQuestion. Continue by calling AskUserQuestion with 2-4 options and keep allowOther enabled unless free-form input is unsafe.')));
    return;
  }

  const cwd = typeof input.cwd === 'string' ? input.cwd : (typeof input.directory === 'string' ? input.directory : process.cwd());
  if (message && COMPLETION_CLAIM_RE.test(message)) {
    const blockers = findCompletionBlockers(cwd);
    if (blockers.length > 0) {
      const details = blockers.map(b => `${b.path}:${b.line} ${b.kind} — ${b.text}`).join('\n');
      console.log(JSON.stringify(makeBlock(`[WORKFLOW DRIFT GUARD] Completion was claimed while changed code still contains TODO/stub/skipped-test blockers. Resolve them or explicitly report the blocker instead of claiming completion.\n${details}`)));
      return;
    }
  }

  console.log(JSON.stringify({ suppressOutput: true }));
}

main().catch((error) => {
  console.error(`[workflow-drift-guard] ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ suppressOutput: true }));
});
