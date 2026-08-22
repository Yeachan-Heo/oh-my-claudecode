#!/usr/bin/env node
/**
 * Durable inventory manifest + call-graph generator for #3702.
 *
 * Ownership: #3702 durable graph/manifest + drift enforcement.
 * Seed census (#3698 seed) lives in scripts/inventory-issue-3698.mjs —
 * this generator extends it with:
 *  - deterministic public/internal/generated counts (separate buckets)
 *  - exact base/head provenance (base + planningHead + head)
 *  - dependency/call graph edges derived from static imports + registry conventions
 *  - committed baseline artifact at inventory/inventory-graph.json
 *
 * Determinism: sorted keys/paths, stable JSON, no timestamps unless
 * ISSUE_3698_INVENTORY_TIMESTAMP or ISSUE_3702_INVENTORY_TIMESTAMP is set
 * (null otherwise). SHA-256 over sorted rel list and manifest body.
 *
 * Rollback: delete this script, the generated inventory/inventory-graph.json
 * baseline, and the associated lint test — no runtime change.
 *
 * Contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md
 *  base = 05c800f40d1ad53b42a78609d2667ef4f726808b
 *  planningHead = 0a91273e61dbbd47eb0af4c02844409251e08398
 *  head = exact HEAD at generation (or ISSUE_3702_HEAD env)
 */

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, resolve } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY = 'Yeachan-Heo/oh-my-claudecode';
const BASE_SHA = '05c800f40d1ad53b42a78609d2667ef4f726808b';
const PLANNING_HEAD_SHA = '0a91273e61dbbd47eb0af4c02844409251e08398';
const SCHEMA_VERSION = 2;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const OUT_PATH = join(REPO_ROOT, 'inventory', 'inventory-graph.json');

// Seed census excludes retained for legacy counts; durable #3702 hashes use stable files below.
const SEED_IGNORES = new Set(['node_modules', '.git', 'dist', 'coverage']);
// Additional ephemeral ignores for counts/graph stability (not for inventorySha parity)
const EPHEMERAL_IGNORES = new Set(['.tmp', '.tmp-02', '.clawhip', '.omc', '.omx', '__pycache__', '.gjc']);
// Exclude self-generated output and base-owned authorization metadata. Neither is
// candidate source: including either creates a provenance feedback loop when main
// refreshes release authorization after the candidate inventory is generated.
const SELF_EXCLUDED = new Set([
  'inventory/inventory-graph.json',
  '.github/generated-artifact-authorizations.json',
]);

function isSeedIgnored(name) {
  return SEED_IGNORES.has(name);
}

function isEphemeralIgnored(name) {
  return EPHEMERAL_IGNORES.has(name) || name.startsWith('.tmp');
}

async function walkStable(root) {
  const tracked = listTrackedFiles(root);
  if (tracked !== null) return tracked.map((p) => join(root, p));
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isSeedIgnored(e.name) || isEphemeralIgnored(e.name)) continue;
      // Skip .log, .DS_Store ephemeral files are still walked but no dir skip needed
      const relCheck = toPosix(relative(root, join(dir, e.name)));
      if (SELF_EXCLUDED.has(relCheck)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else out.push(p);
    }
  }
  await rec(root);
  return out;
}

function toPosix(p) {
  return p.replaceAll('\\', '/');
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function getHeadSha() {
  const override = process.env.ISSUE_3702_HEAD ?? process.env.ISSUE_3698_HEAD;
  if (override !== undefined) {
    const value = override.trim();
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('ISSUE_3702_HEAD must be a 40-character lowercase Git SHA');
    if (!isAncestorCommit(REPO_ROOT, value)) throw new Error('ISSUE_3702_HEAD must identify a commit that is an ancestor of the current HEAD');
    return value;
  }
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('exact HEAD provenance requires a Git checkout or ISSUE_3702_HEAD override');
  }
}

function getGeneratedAt() {
  const v = process.env.ISSUE_3702_INVENTORY_TIMESTAMP ?? process.env.ISSUE_3698_INVENTORY_TIMESTAMP ?? null;
  // Allow explicit "null" string to mean null
  if (v === 'null' || v === '') return null;
  return v;
}

function isAncestorCommit(root, sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function scanDependencies(source, filePath) {
  const out = [];
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false);
  function add(specifier, kind) {
    if (ts.isStringLiteralLike(specifier)) out.push({ spec: specifier.text.trim(), kind });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const hasTypeOnly = clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((element) => element.isTypeOnly));
      const hasRuntime = !clause?.isTypeOnly && (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.some((element) => !element.isTypeOnly) || Boolean(clause.name));
      if (hasRuntime) add(node.moduleSpecifier, 'imports');
      if (hasTypeOnly) add(node.moduleSpecifier, 'type-imports');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const hasTypeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.some((element) => element.isTypeOnly));
      const hasRuntime = !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some((element) => !element.isTypeOnly));
      if (hasRuntime) add(node.moduleSpecifier, 'exports');
      if (hasTypeOnly) add(node.moduleSpecifier, 'type-exports');
    }
    else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'imports');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'imports');
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}

function classifyPath(p) {
  if (/^skills\/[^/]+\/SKILL\.md$/.test(p)) return 'skill';
  if (/^commands\/[^/]+\.md$/.test(p)) return 'command';
  if (p.startsWith('.github/workflows/')) return 'workflow';
  if (/^src\/agents\/[^/]+\.ts$/.test(p)) return 'agent';
  if (p.startsWith('src/hooks/')) return 'hook';
  if (p.startsWith('src/features/')) return 'feature';
  if (p.startsWith('src/tools/')) return 'tool';
  if (p.startsWith('src/lib/')) return 'lib';
  if (p.startsWith('templates/hooks/')) return 'template-hook';
  if (p.startsWith('src/')) return 'src';
  if (/(^|\/)(CLAUDE\.md)$/.test(p) || /(^|\/)prompt/i.test(p)) return 'prompt';
  if (p.startsWith('dist/')) return 'generated-dist';
  if (p.startsWith('bridge/')) return 'generated-bridge';
  if (p.startsWith('scripts/')) return 'script';
  return 'other';
}

function isSourceForGraph(p) {
  // Only source files participate in graph edges — keeps graph stable across builds
  return (
    p.endsWith('.ts') ||
    p.endsWith('.mts') ||
    p.endsWith('.cts') ||
    p.endsWith('.js') ||
    p.endsWith('.mjs') ||
    p.endsWith('.cjs')
  );
}

function resolveImportSpec(fromPath, spec) {
  // Only resolve relative specs; bare specifiers remain as external nodes
  if (spec.startsWith('.')) {
    const base = dirname(fromPath);
    // Try resolve with extensions .ts/.js/.mjs/.cjs and /index variants
    const emittedSourceCandidates = /\.(?:mjs|cjs|js)$/.test(spec)
      ? ['.ts', '.mts', '.cts'].map((extension) => join(base, spec.replace(/\.(?:mjs|cjs|js)$/, extension)))
      : [];
    const candidates = [
      join(base, spec),
      ...emittedSourceCandidates,
      join(base, spec + '.ts'),
      join(base, spec + '.js'),
      join(base, spec + '.mjs'),
      join(base, spec + '.cjs'),
      join(base, spec, 'index.ts'),
      join(base, spec, 'index.js'),
    ].map((candidate) => toPosix(resolve('/', candidate)).slice(1));
    return { kind: 'relative', spec, candidates };
  }
  return { kind: 'external', spec, candidates: [] };
}

async function existsAny(root, cands) {
  for (const c of cands) {
    const absolute = resolve(root, c);
    const confined = relative(root, absolute);
    if (confined.startsWith('..') || confined === '' || resolve(root, confined) !== absolute) continue;
    try {
      await stat(absolute);
      return toPosix(confined);
    } catch {
      // continue
    }
  }
  return null;
}

function listTrackedGenerated(root, prefix) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map(toPosix)
      .sort();
  } catch {
    return null;
  }
}

function listTrackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map(toPosix)
      .filter((p) => !SELF_EXCLUDED.has(p) && !p.startsWith('dist/') && !p.startsWith('bridge/'))
      .sort();
  } catch {
    return null;
  }
}

export async function generateInventoryGraph(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const stableFiles = await walkStable(root);

  const relStable = stableFiles.map((p) => toPosix(relative(root, p))).sort();

  const inventorySha256 = sha256Hex(JSON.stringify(relStable));
  const sourceHasher = createHash('sha256');
  for (const path of relStable) {
    sourceHasher.update(`${path}\0`);
    sourceHasher.update(await readFile(join(root, path)));
    sourceHasher.update('\0');
  }
  const sourceSha256 = sourceHasher.digest('hex');

  // Stable classification for #3702 manifest (deterministic public/internal/generated)
  const skills = relStable.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split('/')[1]).sort();
  const skillPaths = relStable.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).sort();
  const commands = relStable.filter((p) => /^commands\/[^/]+\.md$/.test(p)).map((p) => p.slice('commands/'.length, -3)).sort();
  const commandPaths = relStable.filter((p) => /^commands\/[^/]+\.md$/.test(p)).sort();
  const workflows = relStable.filter((p) => p.startsWith('.github/workflows/')).sort();
  const agents = relStable.filter((p) => /^src\/agents\/[^/]+\.ts$/.test(p)).map((p) => p.slice('src/agents/'.length, -3)).sort();
  const hookFiles = relStable.filter((p) => p.startsWith('src/hooks/')).sort();
  const featureFiles = relStable.filter((p) => p.startsWith('src/features/')).sort();
  const toolFiles = relStable.filter((p) => p.startsWith('src/tools/')).sort();
  const libFiles = relStable.filter((p) => p.startsWith('src/lib/')).sort();
  const templateHookFiles = relStable.filter((p) => p.startsWith('templates/hooks/')).sort();
  const promptSources = relStable.filter((p) => /(^|\/)(CLAUDE\.md|.*prompt.*|prompts?\/)/i.test(p)).sort();
  const scriptFiles = relStable.filter((p) => p.startsWith('scripts/')).sort();
  const srcFiles = relStable.filter((p) => p.startsWith('src/')).sort();

  // Generated: prefer the tracked shipping surface so local builds cannot cause drift.
  const collectGenerated = async (prefix) => {
    const tracked = listTrackedGenerated(root, prefix);
    if (tracked !== null) return tracked;
    const out = [];
    const abs = join(root, prefix);
    if (!existsSync(abs)) return out;
    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = await readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (isEphemeralIgnored(e.name) || e.name.endsWith('.pyc')) continue;
        const p = join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else out.push(toPosix(relative(root, p)));
      }
    }
    return out.sort();
  };
  const genDist = await collectGenerated('dist');
  const genBridge = await collectGenerated('bridge');

  // Build nodes — one per stable file + generated files as nodes (for counts completeness)
  const nodeSet = new Map();
  for (const p of relStable) {
    const kind = classifyPath(p);
    nodeSet.set(p, { id: p, kind, path: p });
  }
  // Include generated as nodes for provenance completeness (but not for edge scanning)
  for (const p of genDist) nodeSet.set(p, { id: p, kind: 'generated-dist', path: p });
  for (const p of genBridge) nodeSet.set(p, { id: p, kind: 'generated-bridge', path: p });

  const nodes = [...nodeSet.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Build edges: static imports + convention edges
  const edgeKeySet = new Set();
  const edges = [];

  function pushEdge(from, to, kind) {
    const key = `${from}\0${to}\0${kind}`;
    if (edgeKeySet.has(key)) return;
    edgeKeySet.add(key);
    edges.push({ from, to, kind });
  }

  // 1) Import-derived edges (source -> imported)
  // Only scan source files for performance + determinism
  const scanTargets = relStable.filter(isSourceForGraph);
  // Sort to ensure deterministic order
  scanTargets.sort();
  for (const from of scanTargets) {
    let src;
    try {
      src = await readFile(join(root, from), 'utf8');
    } catch {
      continue;
    }
    const dependencies = scanDependencies(src, from);
    const uniqueDependencies = [...new Map(dependencies.map((dependency) => [`${dependency.kind}\0${dependency.spec}`, dependency])).values()]
      .sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0);
    for (const { spec, kind } of uniqueDependencies) {
      const resolved = resolveImportSpec(from, spec);
      if (resolved.kind === 'external') {
        // External bare specifier -> still record fact of dependency on external package
        // Use external node id "external:<spec>"
        const to = `external:${spec}`;
        // Add synthetic external node if not present
        if (!nodeSet.has(to)) nodeSet.set(to, { id: to, kind: 'external', path: spec });
        pushEdge(from, to, kind);
      } else {
        // Try to resolve relative to an existing stable file
        const hit = await existsAny(root, resolved.candidates);
        if (hit) {
          // Prefer canonical posix relative
          pushEdge(from, hit, kind);
        } else {
          // Keep unresolved identities path-safe and host-independent.
          const unresolved = `unresolved:${from}#${sha256Hex(spec).slice(0, 16)}`;
          if (!nodeSet.has(unresolved)) nodeSet.set(unresolved, { id: unresolved, kind: 'unresolved', path: unresolved });
          pushEdge(from, unresolved, `${kind}-unresolved`);
        }
      }
    }
  }

  // 2) Convention edges (registry-to-installed) — guarantees registry drift check is meaningful
  // Each skill SKILL.md -> builtin skills registry
  const SKILLS_REGISTRY = 'src/features/builtin-skills/skills.ts';
  const COMMANDS_REGISTRY = 'src/commands/index.ts';
  const HOOK_BRIDGE = 'src/hooks/bridge.ts';
  const HOOKS_JSON = 'hooks/hooks.json';

  for (const p of skillPaths) pushEdge(p, SKILLS_REGISTRY, 'registers');
  for (const p of commandPaths) pushEdge(p, COMMANDS_REGISTRY, 'registers');
  // Template hooks -> hook bridge / hooks.json projection
  for (const p of templateHookFiles) {
    pushEdge(p, HOOK_BRIDGE, 'projects');
    pushEdge(p, HOOKS_JSON, 'projects');
  }
  // Workflows -> generated-artifact authorization / release boundaries
  for (const p of workflows) {
    if (p.includes('generated-artifact')) pushEdge(p, 'scripts/verify-generated-artifact-authorization.mjs', 'verifies');
  }

  edges.sort((a, b) => {
    const c = a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
    if (c !== 0) return c;
    const d = a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    if (d !== 0) return d;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  // Rebuild nodes to include any new external nodes discovered during scan
  const finalNodes = [...nodeSet.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const headSha = getHeadSha();
  const generatedAt = getGeneratedAt();

  const manifestWithoutSha = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    repository: REPOSITORY,
    provenance: {
      base: BASE_SHA,
      planningHead: PLANNING_HEAD_SHA,
      head: headSha,
      sourceSha256,
      generatedAt,
      generator: 'scripts/generate-inventory-graph.mjs',
    },
    // Keep seed-parity top-level for tooling compat
    base: BASE_SHA,
    planningHead: PLANNING_HEAD_SHA,
    head: headSha,
    sourceSha256,
    counts: {
      public: {
        skills: skills.length,
        commands: commands.length,
        workflows: workflows.length,
        agents: agents.length,
        total: skills.length + commands.length + workflows.length + agents.length,
      },
      internal: {
        hookFiles: hookFiles.length,
        featureFiles: featureFiles.length,
        toolFiles: toolFiles.length,
        libFiles: libFiles.length,
        templateHooks: templateHookFiles.length,
        srcFiles: srcFiles.length,
        total: srcFiles.length + templateHookFiles.length,
      },
      generated: {
        distFiles: genDist.length,
        bridgeFiles: genBridge.length,
        total: genDist.length + genBridge.length,
      },
      prompt: {
        promptLikeFiles: promptSources.length,
      },
      // Legacy flat count shape retained for seed-tool consumers.
      skills: skills.length,
      commands: commands.length,
      hookFiles: hookFiles.length,
      workflows: workflows.length,
      agentDefinitions: agents.length,
      promptLikeFiles: promptSources.length,
    },
    public: {
      skills: [...skills],
      commands: [...commands],
      agents: [...agents],
      workflows: [...workflows],
    },
    internal: {
      hookFiles: [...hookFiles],
      featureFiles: [...featureFiles],
      toolFiles: [...toolFiles],
      libFiles: [...libFiles],
      templateHooks: [...templateHookFiles],
      promptSources: [...promptSources],
      scriptFiles: [...scriptFiles],
    },
    generated: {
      distFiles: [...genDist],
      bridgeFiles: [...genBridge],
    },
    paths: {
      hookFiles: [...hookFiles],
      workflows: [...workflows],
      promptSources: [...promptSources],
      featureFiles: [...featureFiles],
      toolFiles: [...toolFiles],
    },
    graph: {
      nodes: finalNodes,
      edges,
      stats: {
        nodeCount: finalNodes.length,
        edgeCount: edges.length,
        importEdgeCount: edges.filter((e) => e.kind === 'imports').length,
        registerEdgeCount: edges.filter((e) => e.kind === 'registers').length,
      },
    },
    inventorySha256,
  };

  const manifestSha256 = sha256Hex(stableStringify(manifestWithoutSha));

  const manifest = {
    ...manifestWithoutSha,
    inventorySha256,
    manifestSha256,
  };

  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const wantVerify = args.includes('--verify');
  const wantWrite = args.includes('--write');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? resolve(args[outIdx + 1] ?? OUT_PATH) : OUT_PATH;
  const outRelative = relative(REPO_ROOT, outPath);
  if (outRelative.startsWith('..') || resolve(REPO_ROOT, outRelative) !== outPath) {
    throw new Error('--out must resolve inside the repository root');
  }

  if (wantVerify) {
    const fresh = await generateInventoryGraph();
    const freshStr = JSON.stringify(fresh, null, 2) + '\n';
    let onDiskStr;
    try {
      onDiskStr = readFileSync(outPath, 'utf8');
    } catch {
      console.error(`[inventory-graph] baseline missing at ${relative(REPO_ROOT, outPath)}`);
      console.error('[inventory-graph] run: node scripts/generate-inventory-graph.mjs --write');
      process.exit(2);
    }
    let onDisk;
    try {
      onDisk = JSON.parse(onDiskStr);
    } catch (e) {
      console.error(`[inventory-graph] baseline is not valid JSON: ${e.message}`);
      process.exit(2);
    }
    // For verify, ignore head/generatedAt diffs unless they are structural provenance errors.
    // Normalize the two for comparison if caller used ephemeral head/timestamp.
    // But enforce base/planningHead exactness and counts/graph determinism.
    const norm = (m) => {
      const c = { ...m };
      // Drop ephemeral head/generatedAt for drift comparison; provenance base/planningHead must still match exactly
      // We keep schemaVersion, repository, counts, public/internal/generated, inventorySha256/manifestSha256, graph
      // For strict verify, we compare the whole fresh vs on-disk after zeroing head/generatedAt if they were null at baseline.
      // Instead: compare stable-stringified without head/generatedAt
      const strip = (x) => {
        const y = JSON.parse(JSON.stringify(x));
        if (y.provenance) {
          y.provenance = { ...y.provenance, head: null, generatedAt: null };
        }
        y.head = null;
        y.generatedAt = null;
        // Recompute manifestSha256 without head/generatedAt for comparison
        delete y.manifestSha256;
        return y;
      };
      return stableKey(strip(c));
    };
    function stableKey(v) {
      const s = JSON.stringify(v, Object.keys(v).sort(), 2);
      // Use recursive sorted via stableStringify for deep determinism
      const recur = (val) => {
        if (val === null || typeof val !== 'object') return JSON.stringify(val);
        if (Array.isArray(val)) return `[${val.map(recur).join(',')}]`;
        const ks = Object.keys(val).sort();
        return `{${ks.map((k) => `${JSON.stringify(k)}:${recur(val[k])}`).join(',')}}`;
      };
      return sha256Hex(recur(v));
    }

    // Strict path: also check base/planningHead exactness before normalized drift
    if (fresh.provenance.base !== BASE_SHA || onDisk.provenance?.base !== BASE_SHA) {
      console.error(`[inventory-graph] provenance.base mismatch: expected ${BASE_SHA}`);
      console.error(`  fresh: ${fresh.provenance.base}`);
      console.error(`  on-disk: ${onDisk.provenance?.base}`);
      process.exit(2);
    }
    if (fresh.provenance.planningHead !== PLANNING_HEAD_SHA || onDisk.provenance?.planningHead !== PLANNING_HEAD_SHA) {
      console.error(`[inventory-graph] provenance.planningHead mismatch: expected ${PLANNING_HEAD_SHA}`);
      console.error(`  fresh: ${fresh.provenance.planningHead}`);
      console.error(`  on-disk: ${onDisk.provenance?.planningHead}`);
      process.exit(2);
    }
    if (!/^[0-9a-f]{40}$/.test(onDisk.head ?? '') || onDisk.provenance?.head !== onDisk.head) {
      console.error('[inventory-graph] provenance.head must be one consistent 40-character lowercase Git SHA');
      process.exit(2);
    }
    if (!isAncestorCommit(REPO_ROOT, onDisk.head)) {
      console.error('[inventory-graph] committed provenance.head must be an ancestor of the current HEAD');
      process.exit(2);
    }
    if (!/^[0-9a-f]{64}$/.test(onDisk.sourceSha256 ?? '') || onDisk.provenance?.sourceSha256 !== onDisk.sourceSha256 || onDisk.sourceSha256 !== fresh.sourceSha256) {
      console.error('[inventory-graph] provenance.sourceSha256 must match the current inventoried source content');
      process.exit(2);
    }
    if (onDisk.inventorySha256 !== fresh.inventorySha256) {
      console.error('[inventory-graph] inventorySha256 mismatch');
      process.exit(1);
    }
    const { manifestSha256: onDiskManifestSha, ...onDiskWithoutSha } = onDisk;
    const recomputedOnDiskManifestSha = sha256Hex(stableStringify(onDiskWithoutSha));
    if (onDiskManifestSha !== recomputedOnDiskManifestSha) {
      console.error('[inventory-graph] manifestSha256 mismatch');
      process.exit(1);
    }
    // Counts drift — public/internal/generated separation must match filesystem
    const freshNorm = norm(fresh);
    const diskNorm = norm(onDisk);
    if (freshNorm !== diskNorm) {
      console.error('[inventory-graph] drift detected: committed baseline differs from freshly generated graph');
      console.error(`  fresh manifestSha (normalized): ${freshNorm.slice(0, 16)}`);
      console.error(`  on-disk manifestSha (normalized): ${diskNorm.slice(0, 16)}`);
      console.error(`  baseline: ${relative(REPO_ROOT, outPath)}`);
      console.error('  to refresh: node scripts/generate-inventory-graph.mjs --write');
      // Emit compact diff of top-level counts for actionable signal
      const fc = fresh.counts, dc = onDisk.counts || {};
      console.error('  counts drift:');
      console.error(`    public  fresh ${JSON.stringify(fc.public)}  vs on-disk ${JSON.stringify(dc.public || dc)}`);
      console.error(`    internal fresh ${JSON.stringify(fc.internal)}  vs on-disk ${JSON.stringify(dc.internal || {})}`);
      console.error(`    generated fresh ${JSON.stringify(fc.generated)}  vs on-disk ${JSON.stringify(dc.generated || {})}`);
      process.exit(1);
    }
    // Also verify re-serializing produces identical manifestSha (determinism guard)
    {
      const s1 = JSON.stringify(fresh, null, 2);
      const f2 = await generateInventoryGraph();
      const s2 = JSON.stringify(f2, null, 2);
      if (sha256Hex(s1) !== sha256Hex(s2)) {
        console.error('[inventory-graph] non-deterministic generation detected');
        process.exit(2);
      }
    }
    console.log('[inventory-graph] verify ok — baseline is current');
    console.log(`  baseline: ${relative(REPO_ROOT, outPath)}`);
    console.log(`  counts: public=${fresh.counts.public.total} internal=${fresh.counts.internal.total} generated=${fresh.counts.generated.total} prompt=${fresh.counts.prompt.promptLikeFiles}`);
    console.log(`  graph: nodes=${fresh.graph.stats.nodeCount} edges=${fresh.graph.stats.edgeCount}`);
    console.log(`  provenance: base=${fresh.provenance.base.slice(0, 12)} planningHead=${fresh.provenance.planningHead.slice(0, 12)} head=${(fresh.provenance.head || 'null').slice(0, 12)}`);
    process.exit(0);
  }

  const manifest = await generateInventoryGraph();
  const json = JSON.stringify(manifest, null, 2) + '\n';

  if (wantWrite) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json, 'utf8');
    console.log(`[inventory-graph] wrote ${relative(REPO_ROOT, outPath)}`);
    console.log(`  counts: public=${manifest.counts.public.total} internal=${manifest.counts.internal.total} generated=${manifest.counts.generated.total}`);
    console.log(`  graph: nodes=${manifest.graph.stats.nodeCount} edges=${manifest.graph.stats.edgeCount}`);
    console.log(`  provenance: base=${manifest.provenance.base.slice(0, 12)} planningHead=${manifest.provenance.planningHead.slice(0, 12)} head=${(manifest.provenance.head || 'null').slice(0, 12)}`);
    console.log(`  sha256: inventory=${manifest.inventorySha256.slice(0, 16)} manifest=${manifest.manifestSha256.slice(0, 16)}`);
  } else {
    process.stdout.write(json);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error('[inventory-graph] fatal:', e?.stack || e?.message || String(e));
    process.exit(2);
  });
}
