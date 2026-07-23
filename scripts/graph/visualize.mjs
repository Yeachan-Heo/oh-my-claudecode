#!/usr/bin/env node
/**
 * Graph-Ralph Visualizer
 *
 * Reads a graph state JSON file and renders an ASCII-art diagram with each
 * node marked by its current activation status:
 *   - ready (pending)    : ⏳
 *   - running (active)   : ▶️
 *   - completed (done)    : ✅
 *   - failed (error)      : ❌
 *
 * ASCII art renders inline in Claude Code's terminal (Mermaid does not).
 * ANSI color is applied only when stdout is a TTY, so captured/piped output
 * stays as clean box-drawing + emoji text.
 *
 * Usage:
 *   node scripts/graph/visualize.mjs <path-to-graph-state.json>
 *   node scripts/graph/visualize.mjs --demo   # simulate a running state
 *   node scripts/graph/visualize.mjs --descriptor <descriptor.json>
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Status metadata
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(['ready', 'running', 'completed', 'failed']);

// emoji always shown; ANSI color applied only when stdout is a TTY
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const STATUS_META = {
  ready: { emoji: '⏳', word: 'ready', color: DIM },
  running: { emoji: '▶️', word: 'running', color: YELLOW },
  completed: { emoji: '✅', word: 'completed', color: GREEN },
  failed: { emoji: '❌', word: 'failed', color: RED },
};

const USE_COLOR = stdout.isTTY === true;

// Cap inner box width so long node IDs (up to 256 chars per ID_PATTERN) do
// not blow the box out past a normal terminal width. Long IDs are truncated
// with an ellipsis instead; see formatLeftContent.
const MAX_INNER_WIDTH = 72;
const ELLIPSIS = '…';

function maybeColor(text, color) {
  return USE_COLOR && color ? `${color}${text}${RESET}` : text;
}

function statusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.ready;
}

// ---------------------------------------------------------------------------
// Visual-width helpers (account for emoji double width + ANSI escapes)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

function visualWidth(text) {
  const clean = stripAnsi(text);
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    // variation selectors, ZWJ, combining marks -> zero width
    if (code === 0xfe0f || code === 0xfe0e || code === 0x200d) continue;
    if (code >= 0x0300 && code <= 0x036f) continue;
    // emoji / pictographic -> double width
    if (code >= 0x1f300) { width += 2; continue; }
    if (code === 0x23f3 || code === 0x2705 || code === 0x274c || code === 0x25b6 || code === 0x25c0 || code === 0x2b22) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

function padRight(text, width) {
  const w = visualWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

function hardBreak(text, width) {
  const out = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

function wrapText(text, width) {
  const safeWidth = Math.max(1, width);
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (visualWidth(current + ' ' + word) <= safeWidth) current += ' ' + word;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.flatMap((line) =>
    visualWidth(line) > safeWidth ? hardBreak(line, safeWidth) : [line],
  );
}

// ---------------------------------------------------------------------------
// Graph layout
// ---------------------------------------------------------------------------

function normalizeStatus(status) {
  return VALID_STATUSES.has(status) ? status : 'ready';
}

function buildNodeStatusMap(state) {
  const map = new Map();
  if (!state?.projection?.activations) return map;
  for (const activation of Object.values(state.projection.activations)) {
    const existingStatus = map.get(activation.node_id);
    const status = normalizeStatus(activation.status);
    // A 'ready'/'running' activation means the node is being (re)tried and
    // should override a stale 'failed' activation left behind by a back-edge
    // retry. Only keep 'failed' when no live activation remains for the node.
    const statusIsLive = status === 'ready' || status === 'running';
    const existingIsLive = existingStatus === 'ready' || existingStatus === 'running';
    if (!existingStatus) {
      map.set(activation.node_id, status);
    } else if (statusIsLive && !existingIsLive) {
      map.set(activation.node_id, status);
    } else if (!statusIsLive && existingIsLive) {
      // keep existing live status
    } else if (priority(existingStatus) < priority(status)) {
      map.set(activation.node_id, status);
    }
  }
  return map;
}

function priority(status) {
  return { running: 4, failed: 3, completed: 2, ready: 1 }[status] ?? 0;
}

/**
 * DFS topological order over non-back-edge edges. Back-edges are excluded
 * (they point backward, often to self) and rendered separately as side-notes.
 * Successors are visited in declared edge order so siblings group together.
 */
export function topologicalOrder(descriptor) {
  const nodes = descriptor.nodes ?? [];
  const successors = new Map();
  for (const node of nodes) successors.set(node.id, []);
  for (const edge of descriptor.edges ?? []) {
    if ((edge.kind ?? 'fixed') === 'back_edge') continue;
    if (!successors.has(edge.from)) successors.set(edge.from, []);
    successors.get(edge.from).push(edge.to);
  }
  const visited = new Set();
  const onStack = new Set();
  const post = [];
  function visit(id) {
    if (visited.has(id) || onStack.has(id)) return;
    onStack.add(id);
    for (const target of successors.get(id) ?? []) visit(target);
    onStack.delete(id);
    visited.add(id);
    post.push(id);
  }
  for (const entry of descriptor.entry_node_ids ?? []) visit(entry);
  for (const node of nodes) visit(node.id);
  return post.reverse();
}

/**
 * Build the left side of a node box's status row (emoji + prefix + id) and
 * truncate the id with an ellipsis so the row fits within MAX_INNER_WIDTH.
 * Shared by pickInnerWidth (sizing) and renderNodeBox (rendering) so the box
 * width and the rendered content can never drift out of agreement.
 *
 * Returns { display, width } where display is the plain (uncolored) string
 * and width is its visual width.
 */
function formatLeftContent(node, status) {
  const meta = statusMeta(status);
  const prefix = node.kind === 'join' ? '⬢ ' : '';
  const head = `${meta.emoji} ${prefix}`;
  const headW = visualWidth(head);
  const rightW = visualWidth(meta.word);
  // Reserve headW + rightW + 4 (left/right padding + gaps) inside the cap.
  const idBudget = MAX_INNER_WIDTH - headW - rightW - 4;
  const id = String(node.id ?? '');
  const idW = visualWidth(id);
  if (idW <= idBudget) {
    const display = `${head}${id}`;
    return { display, width: headW + idW };
  }
  const ellipsisW = visualWidth(ELLIPSIS);
  const budget = Math.max(1, idBudget - ellipsisW);
  // Trim code points (not bytes) until the id fits the remaining budget.
  let kept = '';
  let keptW = 0;
  for (const ch of id) {
    const chW = visualWidth(ch);
    if (keptW + chW > budget) break;
    kept += ch;
    keptW += chW;
  }
  const display = `${head}${kept}${ELLIPSIS}`;
  return { display, width: headW + keptW + ellipsisW };
}

function pickInnerWidth(descriptor, nodeStatus) {
  let width = 28;
  for (const node of descriptor.nodes ?? []) {
    const status = normalizeStatus(nodeStatus.get(node.id) ?? 'ready');
    const { width: leftW } = formatLeftContent(node, status);
    const rightW = visualWidth(statusMeta(status).word);
    const need = leftW + rightW + 4;
    if (need > width) width = need;
  }
  // Cap at a terminal-friendly max; long IDs are truncated by
  // formatLeftContent rather than widening the box unbounded.
  return Math.min(width, MAX_INNER_WIDTH);
}

function renderNodeBox(node, status, innerWidth) {
  const meta = statusMeta(status);
  const { display: leftRaw, width: leftW } = formatLeftContent(node, status);
  const left = maybeColor(leftRaw, meta.color);
  const right = maybeColor(meta.word, meta.color);
  const gapW = innerWidth - 2 - leftW - visualWidth(meta.word);
  const gap = gapW > 1 ? ' '.repeat(gapW) : ' ';

  const rounded = node.kind === 'human-approval';
  const tl = rounded ? '╭' : '┌';
  const tr = rounded ? '╮' : '┐';
  const bl = rounded ? '╰' : '└';
  const br = rounded ? '╯' : '┘';
  const bar = '─'.repeat(innerWidth);

  const rows = [];
  rows.push(`${tl}${bar}${tr}`);
  rows.push(`│${padRight(' ' + left + gap + right + ' ', innerWidth)}│`);
  const titleLines = wrapText(node.title ?? '', innerWidth - 2);
  for (const titleLine of titleLines.length ? titleLines : ['']) {
    rows.push(`│${padRight(' ' + titleLine + ' ', innerWidth)}│`);
  }
  rows.push(`${bl}${bar}${br}`);
  return rows;
}

function renderForwardEdge(edge, centerCol) {
  const kind = edge.kind ?? 'fixed';
  const isConditional = kind === 'conditional';
  const isFanOut = kind === 'fan_out';
  const shaft = isFanOut ? '║' : (isConditional ? '╎' : '│');
  const head = isConditional ? '▽' : '▼';
  const label = (edge.route || edge.branch_id) ? ` ${edge.route || edge.branch_id}` : '';
  const indent = ' '.repeat(centerCol);
  return [`${indent}${shaft}${label}`, `${indent}${head}`];
}

function renderBackEdgeNote(edge, innerWidth) {
  const route = edge.route ?? 'retry';
  const max = typeof edge.max_traversals === 'number' ? ` (max ${edge.max_traversals})` : '';
  const label = `↺ ${route}${max} -> ${edge.to}`;
  const dashCount = Math.max(4, innerWidth - 8);
  return `   ◂${'─'.repeat(dashCount)}┘  ${label}`;
}

export function renderAsciiGraph(descriptor, nodeStatus, runStatus) {
  const order = topologicalOrder(descriptor);
  const byId = new Map((descriptor.nodes ?? []).map((node) => [node.id, node]));
  const innerWidth = pickInnerWidth(descriptor, nodeStatus);
  const boxIndent = 2;
  const centerCol = boxIndent + 1 + Math.floor(innerWidth / 2);
  const indent = ' '.repeat(boxIndent);

  const forwardBySource = new Map();
  const backBySource = new Map();
  for (const edge of descriptor.edges ?? []) {
    const map = (edge.kind ?? 'fixed') === 'back_edge' ? backBySource : forwardBySource;
    if (!map.has(edge.from)) map.set(edge.from, []);
    map.get(edge.from).push(edge);
  }

  // Progress summary line: at-a-glance completion view across the whole graph.
  let completed = 0;
  const progressParts = [];
  for (const id of order) {
    const status = normalizeStatus(nodeStatus.get(id) ?? 'ready');
    const meta = statusMeta(status);
    if (status === 'completed') completed += 1;
    const token = `${id}${meta.emoji}`;
    const colored = maybeColor(token, meta.color);
    progressParts.push(status === 'completed' ? `[${colored}]` : colored);
  }
  const total = order.length;

  const lines = [];
  if (runStatus) {
    lines.push(`(run status: ${runStatus})`);
    lines.push('');
  }
  lines.push(`Progress: ${completed}/${total} done  ${progressParts.join(' -> ')}`);
  lines.push('');

  for (let index = 0; index < order.length; index += 1) {
    const node = byId.get(order[index]);
    if (!node) continue;
    const status = normalizeStatus(nodeStatus.get(node.id) ?? 'ready');
    for (const row of renderNodeBox(node, status, innerWidth)) {
      lines.push(indent + row);
    }
    for (const edge of backBySource.get(node.id) ?? []) {
      lines.push(indent + renderBackEdgeNote(edge, innerWidth));
    }
    const forwards = forwardBySource.get(node.id) ?? [];
    for (const edge of forwards) {
      lines.push(...renderForwardEdge(edge, centerCol));
    }
  }

  return lines.join('\n');
}

export function renderHeader(state, descriptor) {
  const hash = state?.active_revision_hash ?? 'pending';
  const hashShort =
    typeof hash === 'string' && hash.length >= 8 ? hash.slice(0, 8) : (hash || 'pending');
  const goal = descriptor.goal ?? '(no goal)';
  const status = state?.status ?? 'unknown';
  const entry = (descriptor.entry_node_ids ?? []).join(', ') || '(none)';
  const terminal = descriptor.terminal_verification_node_id ?? '(none)';
  const concurrency = descriptor.concurrency_limit ?? 1;

  const lines = [];
  const goalLines = wrapText(goal, 58);
  lines.push(`Goal: ${goalLines[0]}`);
  for (let index = 1; index < goalLines.length; index += 1) {
    lines.push(`      ${goalLines[index]}`);
  }
  lines.push(`Run: ${status}   #${hashShort}   Concurrency: ${concurrency}`);
  lines.push(`Entry: ${entry}   Terminal: ${terminal}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// State / descriptor loading (unchanged behavior)
// ---------------------------------------------------------------------------

function loadState(path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: Graph state file not found: ${path}`);
      console.error('');
      console.error('Ralph/graph may not be running. Use --demo to see a simulated state:');
      console.error('  node scripts/graph/visualize.mjs --demo');
      exit(1);
    }
    if (error.code === 'EACCES') {
      console.error(`Error: Permission denied reading: ${path}`);
      exit(1);
    }
    if (error.code === 'EISDIR') {
      console.error(`Error: Expected a file but found a directory: ${path}`);
      console.error('  Specify the graph-state.json file path, not a directory.');
      exit(1);
    }
    if (error.code === 'ENOTDIR') {
      console.error(`Error: Path contains a non-directory component: ${path}`);
      console.error('  Check the file path for typos or incorrect separators.');
      exit(1);
    }
    console.error(`Error reading file ${path}: ${error.message}`);
    exit(1);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in state file: ${path}`);
      console.error(`  ${error.message}`);
      exit(1);
    }
    console.error(`Error parsing JSON from ${path}: ${error.message}`);
    exit(1);
  }
}

function extractDescriptor(state) {
  const revisionId = state.active_revision_id;
  const revision = state.revisions?.[revisionId];
  if (!revision?.descriptor) {
    throw new Error(`Could not find descriptor for revision ${revisionId}`);
  }
  return revision.descriptor;
}

// NOTE: canonicalJson and computeDescriptorHash duplicate the logic in
// src/graph/descriptor.ts. They are kept here so the script runs without
// requiring `npm run build` first. If the canonical JSON format in the
// source changes, update this function to match. See computeDescriptorHash
// in src/graph/descriptor.ts for the authoritative implementation.
function canonicalJson(value) {
  if (value === undefined) {
    throw new TypeError('Canonical JSON does not support undefined values');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

function computeDescriptorHash(descriptor) {
  const payload = {
    descriptor_version: descriptor.descriptor_version,
    run_id: descriptor.run_id,
    revision_id: descriptor.revision_id,
    goal: descriptor.goal,
    nodes: descriptor.nodes,
    edges: descriptor.edges,
    entry_node_ids: descriptor.entry_node_ids,
    concurrency_limit: descriptor.concurrency_limit,
    terminal_verification_node_id: descriptor.terminal_verification_node_id,
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function loadExampleDescriptor() {
  const descriptorPath = new URL('../../examples/graph/auth-feature-descriptor.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Error: Example descriptor file not found:');
      console.error(`  ${descriptorPath.pathname}`);
      console.error('');
      console.error('The demo requires examples/graph/auth-feature-descriptor.json to exist.');
      console.error('Reinstall the oh-my-claudecode package or restore the file from git.');
      exit(1);
    }
    if (error instanceof SyntaxError) {
      console.error('Error: Example descriptor file has invalid JSON:');
      console.error(`  ${error.message}`);
      exit(1);
    }
    console.error(`Error loading example descriptor: ${error.message}`);
    exit(1);
  }
}

function demoState() {
  const descriptor = loadExampleDescriptor();
  const revisionId = descriptor.revision_id ?? 'rev-1';
  let hash;
  try {
    hash = computeDescriptorHash(descriptor);
  } catch (error) {
    console.error(`Error computing descriptor hash: ${error.message}`);
    console.error('The example descriptor may be malformed. Check examples/graph/auth-feature-descriptor.json');
    exit(1);
  }
  return {
    status: 'running',
    active_revision_id: revisionId,
    active_revision_hash: hash,
    revisions: {
      [revisionId]: {
        revision_id: revisionId,
        descriptor_hash: hash,
        created_at: '2026-07-22T00:00:00Z',
        invalidated_node_ids: [],
        descriptor: { ...descriptor, descriptor_hash: hash },
      },
    },
    projection: {
      activations: {
        'act-1': { activation_id: 'act-1', node_id: 'explore', status: 'completed', attempt_no: 1, attempt_ids: ['att-1'], traversal_owner_id: 'act-1' },
        'act-2': { activation_id: 'act-2', node_id: 'plan', status: 'completed', attempt_no: 1, attempt_ids: ['att-2'], traversal_owner_id: 'act-2' },
        'act-3': { activation_id: 'act-3', node_id: 'implement', status: 'running', attempt_no: 1, attempt_ids: ['att-3'], active_attempt_id: 'att-3', traversal_owner_id: 'act-3' },
      },
      cohorts: {},
      branch_tokens: {},
      traversal_counts: {},
      committed_transitions: {},
      terminal_verification_activation_ids: [],
    },
  };
}

function loadDescriptor(path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: Descriptor file not found: ${path}`);
      exit(1);
    }
    if (error.code === 'EISDIR') {
      console.error(`Error: Expected a file but found a directory: ${path}`);
      exit(1);
    }
    console.error(`Error reading file ${path}: ${error.message}`);
    exit(1);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in descriptor file: ${path}`);
      console.error(`  ${error.message}`);
      exit(1);
    }
    console.error(`Error parsing JSON from ${path}: ${error.message}`);
    exit(1);
  }
}

function stateFromDescriptor(descriptor) {
  const revisionId = descriptor.revision_id ?? 'rev-1';
  const activations = {};
  for (const [index, node] of descriptor.entry_node_ids.entries()) {
    activations[`act-entry-${index}`] = {
      activation_id: `act-entry-${index}`,
      node_id: node,
      status: 'ready',
      attempt_no: 0,
      attempt_ids: [],
      traversal_owner_id: `act-entry-${index}`,
    };
  }
  return {
    status: 'awaiting_approval',
    active_revision_id: revisionId,
    active_revision_hash: descriptor.descriptor_hash ?? 'pending',
    revisions: {
      [revisionId]: {
        revision_id: revisionId,
        descriptor_hash: descriptor.descriptor_hash ?? 'pending',
        created_at: '2026-07-22T00:00:00Z',
        invalidated_node_ids: [],
        descriptor,
      },
    },
    projection: {
      activations,
      cohorts: {},
      branch_tokens: {},
      traversal_counts: {},
      committed_transitions: {},
      terminal_verification_activation_ids: [],
    },
  };
}

function main() {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: visualize.mjs <graph-state.json>');
    console.log('       visualize.mjs --demo');
    console.log('       visualize.mjs --descriptor <descriptor.json>');
    console.log('');
    console.log('Renders an ASCII-art diagram of the graph (renders inline in Claude Code).');
    exit(0);
  }

  let state;
  if (args[0] === '--demo') {
    state = demoState();
  } else if (args[0] === '--descriptor') {
    if (!args[1]) {
      console.error('Error: --descriptor requires a file path');
      exit(1);
    }
    const descriptor = loadDescriptor(args[1]);
    state = stateFromDescriptor(descriptor);
  } else {
    state = loadState(args[0]);
  }

  try {
    const descriptor = extractDescriptor(state);
    const nodeStatus = buildNodeStatusMap(state);

    console.log(renderHeader(state, descriptor));
    console.log(renderAsciiGraph(descriptor, nodeStatus, state?.status));
  } catch (error) {
    console.error(`Error: Could not render graph visualization: ${error.message}`);
    console.error('');
    console.error('The graph state file may be malformed or corrupted.');
    console.error('Check that the file was written by a valid oh-my-claudecode graph run.');
    exit(1);
  }
}

// Run main() only when executed directly, not when imported by tests.
const isMain =
  argv[1] && fileURLToPath(import.meta.url) === resolve(argv[1]);
if (isMain) {
  main();
}
