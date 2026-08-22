/**
 * @file Drift enforcement for #3702 durable inventory graph/manifest.
 *
 * This test is the "ongoing drift enforcement" owned by #3702. It asserts:
 *  - committed baseline exists and is valid JSON with the expected schema
 *  - public/internal/generated counts are separately reported and match filesystem
 *  - registry-to-installed drift: installed skills/commands/workflows/agents equal
 *    the manifest's public lists (no phantom entries) — the "registry-to-installed
 *    drift test" required by #3702
 *  - exact base/head provenance (base + planningHead immutable, head present)
 *  - deterministic graph: re-running the generator yields an identical manifest
 *    modulo ephemeral head/generatedAt; the embedded manifestSha256 is consistent
 *  - verify mode passes (normalized content drift check)
 *
 * Rollback boundary: delete tests/lint/inventory-graph-drift.test.ts,
 * scripts/generate-inventory-graph.mjs, and inventory/inventory-graph.json
 * — no runtime change.
 *
 * Contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md
 *  base = 05c800f40d1ad53b42a78609d2667ef4f726808b
 *  planningHead = 0a91273e61dbbd47eb0af4c02844409251e08398
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(join(import.meta.dirname, '../..'));
const BASELINE = join(REPO_ROOT, 'inventory', 'inventory-graph.json');
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-inventory-graph.mjs');

const EXPECTED_BASE = '05c800f40d1ad53b42a78609d2667ef4f726808b';
const EXPECTED_PLANNING_HEAD = '0a91273e61dbbd47eb0af4c02844409251e08398';
const SEED_IGNORES = new Set(['node_modules', '.git', 'dist', 'coverage']);
const EPHEMERAL_IGNORES = new Set(['.tmp', '.tmp-02', '.clawhip', '.omc', '.omx', '__pycache__', '.gjc']);
const STABLE_EXCLUDED = new Set([
  'inventory/inventory-graph.json',
  '.github/generated-artifact-authorizations.json',
]);

type Counts = {
  public: { skills: number; commands: number; workflows: number; agents: number; total: number };
  internal: { hookFiles: number; featureFiles: number; toolFiles: number; libFiles: number; templateHooks: number; srcFiles: number; total: number };
  generated: { distFiles: number; bridgeFiles: number; total: number };
  prompt: { promptLikeFiles: number };
  skills: number;
  commands: number;
  hookFiles: number;
  workflows: number;
  agentDefinitions: number;
  promptLikeFiles: number;
};

type Manifest = {
  schemaVersion: number;
  generatedAt: string | null;
  repository: string;
  provenance: { base: string; planningHead: string; head: string | null; sourceSha256: string; generatedAt: string | null; generator: string };
  base: string;
  planningHead: string;
  head: string | null;
  sourceSha256: string;
  counts: Counts;
  public: { skills: string[]; commands: string[]; agents: string[]; workflows: string[] };
  internal: {
    hookFiles: string[];
    featureFiles: string[];
    toolFiles: string[];
    libFiles: string[];
    templateHooks: string[];
    promptSources: string[];
    scriptFiles: string[];
  };
  generated: { distFiles: string[]; bridgeFiles: string[] };
  paths: { hookFiles: string[]; workflows: string[]; promptSources: string[]; featureFiles: string[]; toolFiles: string[] };
  graph: { nodes: Array<{ id: string; kind: string; path: string }>; edges: Array<{ from: string; to: string; kind: string }>; stats: { nodeCount: number; edgeCount: number } };
  inventorySha256: string;
  manifestSha256: string;
};

function loadManifest(): Manifest {
  if (!existsSync(BASELINE)) throw new Error(`baseline missing at ${relative(REPO_ROOT, BASELINE)} — run: node scripts/generate-inventory-graph.mjs --write`);
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Manifest;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as unknown[]).map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function collectStableRel(): string[] {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (tracked.status === 0) {
    return tracked.stdout.split('\0').filter(Boolean).map((p) => p.replaceAll('\\', '/'))
      .filter((p) => !STABLE_EXCLUDED.has(p) && !p.startsWith('dist/') && !p.startsWith('bridge/')).sort();
  }
  const out: string[] = [];
  function rec(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SEED_IGNORES.has(e.name) || EPHEMERAL_IGNORES.has(e.name) || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      const rel = relative(REPO_ROOT, p).replaceAll('\\', '/');
      if (STABLE_EXCLUDED.has(rel)) continue;
      if (e.isDirectory()) rec(p);
      else out.push(rel);
    }
  }
  rec(REPO_ROOT);
  return out.sort();
}

function collectGeneratedRel(prefix: string): string[] {
  const tracked = spawnSync('git', ['ls-files', '-z', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (tracked.status === 0) {
    return tracked.stdout.split('\0').filter(Boolean).map((p) => p.replaceAll('\\', '/')).sort();
  }
  const root = join(REPO_ROOT, prefix);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  function rec(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EPHEMERAL_IGNORES.has(e.name) || e.name.startsWith('.tmp') || e.name.endsWith('.pyc')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(relative(REPO_ROOT, p).replaceAll('\\', '/'));
    }
  }
  rec(root);
  return out.sort();
}

const manifest = (() => {
  try {
    return loadManifest();
  } catch {
    return null as unknown as Manifest;
  }
})();

describe('inventory-graph drift enforcement (#3702)', () => {
  it('baseline exists and generator exists', () => {
    expect(existsSync(BASELINE), `missing ${relative(REPO_ROOT, BASELINE)} — run scripts/generate-inventory-graph.mjs --write`).toBe(true);
    expect(existsSync(GENERATOR), `missing ${relative(REPO_ROOT, GENERATOR)}`).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'inventory-issue-3698.mjs')), 'seed census (owned by #3701) must co-exist — do not remove').toBe(true);
  });

  it('baseline is valid JSON with expected schema + provenance', () => {
    expect(manifest).not.toBeNull();
    const m = manifest!;
    expect(m.schemaVersion).toBe(2);
    expect(m.repository).toBe('Yeachan-Heo/oh-my-claudecode');
    expect(m.provenance.base).toBe(EXPECTED_BASE);
    expect(m.provenance.planningHead).toBe(EXPECTED_PLANNING_HEAD);
    expect(m.base).toBe(EXPECTED_BASE);
    expect(m.planningHead).toBe(EXPECTED_PLANNING_HEAD);
    // head is the exact provenance hook into the branch this was generated from
    expect(typeof m.head === 'string' || m.head === null).toBe(true);
    if (m.head !== null) expect(m.head).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof m.inventorySha256).toBe('string');
    expect(m.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof m.manifestSha256).toBe('string');
    expect(m.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.provenance.sourceSha256).toBe(m.sourceSha256);
    expect(m.graph).toBeTruthy();
    expect(Array.isArray(m.graph.nodes)).toBe(true);
    expect(Array.isArray(m.graph.edges)).toBe(true);
    expect(m.graph.stats.nodeCount).toBe(m.graph.nodes.length);
    expect(m.graph.stats.edgeCount).toBe(m.graph.edges.length);
    expect(m.graph.stats.nodeCount).toBeGreaterThan(500);
    expect(m.graph.stats.edgeCount).toBeGreaterThan(100);
    const nodeIds = new Set(m.graph.nodes.map((node) => node.id));
    expect(m.graph.edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))).toEqual([]);
    const graphPaths = [
      ...m.graph.nodes.flatMap((node) => [node.id, node.path]),
      ...m.graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ].filter((value) => !value.startsWith('external:') && !value.startsWith('unresolved:'));
    for (const graphPath of graphPaths) {
      expect(isAbsolute(graphPath), `absolute graph path: ${graphPath}`).toBe(false);
      expect(graphPath.includes('\\'), `platform-specific graph path: ${graphPath}`).toBe(false);
      expect(normalize(graphPath).startsWith('..'), `graph path escapes repository: ${graphPath}`).toBe(false);
      expect(graphPath.split('/').includes('..'), `non-canonical graph path: ${graphPath}`).toBe(false);
    }
  });

  it('reports public/internal/generated counts separately (no conflation)', () => {
    const m = manifest!;
    expect(m.counts).toBeTruthy();
    expect(m.counts.public).toBeTruthy();
    expect(m.counts.internal).toBeTruthy();
    expect(m.counts.generated).toBeTruthy();
    expect(m.counts.prompt).toBeTruthy();
    // Legacy flat aliases remain for compat with seed tooling
    expect(m.counts.skills).toBe(m.counts.public.skills);
    expect(m.counts.hookFiles).toBe(m.counts.internal.hookFiles);
    expect(m.counts.workflows).toBe(m.counts.public.workflows);
    // Separation: generated is not counted inside public
    expect(m.counts.public.total).toBe(m.counts.public.skills + m.counts.public.commands + m.counts.public.workflows + m.counts.public.agents);
    // Internal total is srcFiles+templateHooks (not a hidden sum across layers)
    expect(m.counts.internal.total).toBe(m.counts.internal.srcFiles + m.counts.internal.templateHooks);
  });

  it('registry-to-installed drift: public lists match filesystem', () => {
    const m = manifest!;
    const stable = collectStableRel();
    const liveSkills = stable.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split('/')[1]).sort();
    const liveCommands = stable.filter((p) => /^commands\/[^/]+\.md$/.test(p)).map((p) => p.slice('commands/'.length, -3)).sort();
    const liveWorkflows = stable.filter((p) => p.startsWith('.github/workflows/')).sort();
    const liveAgents = stable.filter((p) => /^src\/agents\/[^/]+\.ts$/.test(p)).map((p) => p.slice('src/agents/'.length, -3)).sort();

    const missing = (live: string[], listed: string[]) => live.filter((x) => !listed.includes(x));
    const extra = (live: string[], listed: string[]) => listed.filter((x) => !live.includes(x));

    expect(m.public.skills, `skills drift — missing in manifest: ${missing(liveSkills, m.public.skills).join(', ')} extra: ${extra(liveSkills, m.public.skills).join(', ')}`).toEqual(liveSkills);
    expect(m.public.commands).toEqual(liveCommands);
    expect(m.public.workflows).toEqual(liveWorkflows);
    expect(m.public.agents).toEqual(liveAgents);

    expect(m.counts.public.skills).toBe(liveSkills.length);
    expect(m.counts.public.commands).toBe(liveCommands.length);
    expect(m.counts.public.workflows).toBe(liveWorkflows.length);
    expect(m.counts.public.agents).toBe(liveAgents.length);
  });

  it('public/internal/generated counts match filesystem census', () => {
    const m = manifest!;
    const stable = collectStableRel();
    const liveHooks = stable.filter((p) => p.startsWith('src/hooks/')).length;
    const liveFeatures = stable.filter((p) => p.startsWith('src/features/')).length;
    const liveTools = stable.filter((p) => p.startsWith('src/tools/')).length;
    const liveLib = stable.filter((p) => p.startsWith('src/lib/')).length;
    const liveTH = stable.filter((p) => p.startsWith('templates/hooks/')).length;
    const livePrompt = stable.filter((p) => /(^|\/)(CLAUDE\.md|.*prompt.*|prompts?\/)/i.test(p)).length;

    expect(m.counts.internal.hookFiles).toBe(liveHooks);
    expect(m.counts.internal.featureFiles).toBe(liveFeatures);
    expect(m.counts.internal.toolFiles).toBe(liveTools);
    expect(m.counts.internal.libFiles).toBe(liveLib);
    expect(m.counts.internal.templateHooks).toBe(liveTH);
    expect(m.counts.prompt.promptLikeFiles).toBe(livePrompt);

    const liveDist = collectGeneratedRel('dist');
    const liveBridge = collectGeneratedRel('bridge');
    expect(m.generated.distFiles).toEqual(liveDist);
    expect(m.generated.bridgeFiles).toEqual(liveBridge);
    expect(m.counts.generated.distFiles).toBe(liveDist.length);
    expect(m.counts.generated.bridgeFiles).toBe(liveBridge.length);
    expect(m.counts.generated.total).toBe(liveDist.length + liveBridge.length);

    // Durable inventory hash excludes local workflow/cache state and generated self-output.
    const liveInventorySha = sha256Hex(JSON.stringify(stable));
    expect(m.inventorySha256).toBe(liveInventorySha);
  });

  it('manifestSha256 is consistent with content (determinism guard)', () => {
    const m = manifest!;
    const without = { ...(m as unknown as Record<string, unknown>) };
    delete without.manifestSha256;
    const recomputed = sha256Hex(stableStringify(without));
    expect(m.manifestSha256).toBe(recomputed);
  });

  it('graph contains expected registry/register edges (call-graph coverage)', () => {
    const m = manifest!;
    const edgeKeys = new Set(m.graph.edges.map((e) => `${e.from} -> ${e.to} [${e.kind}]`));
    // Every skill SKILL.md registers into the skills registry
    for (const skill of m.public.skills) {
      const from = `skills/${skill}/SKILL.md`;
      expect(edgeKeys.has(`${from} -> src/features/builtin-skills/skills.ts [registers]`), `missing skill register edge ${from}`).toBe(true);
    }
    for (const cmd of m.public.commands) {
      const from = `commands/${cmd}.md`;
      expect(edgeKeys.has(`${from} -> src/commands/index.ts [registers]`), `missing command register edge ${from}`).toBe(true);
    }
    expect(edgeKeys.has('src/agents/definitions.ts -> src/agents/definitions.ts [registers]')).toBe(false);
    // At least one hook-bridge edge exists
    expect(m.graph.edges.some((e) => e.kind === 'imports')).toBe(true);
    expect(edgeKeys.has('src/agents/index.ts -> src/agents/definitions.ts [exports]')).toBe(true);
    expect(m.graph.edges.some((e) => e.kind === 'type-imports')).toBe(true);
    expect(m.graph.edges.some((e) => e.from === 'src/cli/autoresearch-guided.ts' && e.kind === 'imports')).toBe(true);
    expect(m.graph.edges.some((e) => e.from === 'src/cli/autoresearch-guided.ts' && e.kind === 'type-imports')).toBe(true);
    expect(m.graph.edges.some((e) => e.from === 'src/features/delegation-categories/index.ts' && e.kind.endsWith('-unresolved'))).toBe(false);
  });

  it('generator is deterministic (two consecutive runs yield identical manifest modulo head/generatedAt)', () => {
    const opts = { cwd: REPO_ROOT, encoding: 'utf8' as const, maxBuffer: 20 * 1024 * 1024 };
    const r1 = spawnSync('node', [GENERATOR], opts);
    expect(r1.status, r1.stderr || r1.stdout).toBe(0);
    const r2 = spawnSync('node', [GENERATOR], opts);
    expect(r2.status, r2.stderr || r2.stdout).toBe(0);
    const a = JSON.parse(r1.stdout as unknown as string) as Manifest;
    const b = JSON.parse(r2.stdout as unknown as string) as Manifest;
    // Strip ephemeral head/generatedAt + manifestSha before comparison; provenance.base/planningHead must still match exactly
    const strip = (m: Manifest) => {
      const c = JSON.parse(JSON.stringify(m)) as Manifest;
      (c as unknown as Record<string, unknown>).head = null;
      (c as unknown as Record<string, unknown>).generatedAt = null;
      c.provenance = { ...c.provenance, head: null, generatedAt: null };
      // manifestSha is derived from the above, so drop it for the drift-equivalence check
      delete (c as unknown as Record<string, unknown>).manifestSha256;
      // inventorySha is deterministic already but keep for comparison after strip; drop head-dependent hash dominance
      return c;
    };
    const sa = stableStringify(strip(a));
    const sb = stableStringify(strip(b));
    expect(sha256Hex(sa)).toBe(sha256Hex(sb));
    expect(a.provenance.base).toBe(EXPECTED_BASE);
    expect(b.provenance.base).toBe(EXPECTED_BASE);
    expect(a.provenance.planningHead).toBe(EXPECTED_PLANNING_HEAD);
    expect(b.provenance.planningHead).toBe(EXPECTED_PLANNING_HEAD);
  });

  it('verify mode passes when baseline is current (drift closed)', () => {
    const r = spawnSync('node', [GENERATOR, '--verify'], { cwd: REPO_ROOT, encoding: 'utf8' as const, maxBuffer: 20 * 1024 * 1024 });
    expect(r.status, `verify failed — stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect((r.stdout as unknown as string)).toContain('verify ok');
  });

  it('verify mode rejects tampered hashes and head provenance', { timeout: 60_000 }, () => {
    const opts = { cwd: REPO_ROOT, encoding: 'utf8' as const, maxBuffer: 20 * 1024 * 1024 };
    for (const mutate of [
      (m: Manifest) => { m.inventorySha256 = '0'.repeat(64); },
      (m: Manifest) => { m.manifestSha256 = '0'.repeat(64); },
      (m: Manifest) => { m.head = 'not-a-sha'; m.provenance.head = 'not-a-sha'; },
    ]) {
      const temp = join(REPO_ROOT, `.tmp-inventory-graph-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
      const copy = JSON.parse(JSON.stringify(manifest)) as Manifest;
      mutate(copy);
      writeFileSync(temp, `${JSON.stringify(copy, null, 2)}\n`);
      try {
        const result = spawnSync('node', [GENERATOR, '--verify', '--out', temp], opts);
        expect(result.status, `tampered baseline unexpectedly passed: ${result.stdout}`).not.toBe(0);
      } finally {
        unlinkSync(temp);
      }
    }
    const invalidOverride = spawnSync('node', [GENERATOR], { ...opts, env: { ...process.env, ISSUE_3702_HEAD: 'bogus' } });
    expect(invalidOverride.status).not.toBe(0);
    const unreachableOverride = spawnSync('node', [GENERATOR], { ...opts, env: { ...process.env, ISSUE_3702_HEAD: '0'.repeat(40) } });
    expect(unreachableOverride.status).not.toBe(0);

    const detached = spawnSync('git', ['commit-tree', 'HEAD^{tree}', '-m', 'detached inventory provenance'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Inventory Test',
        GIT_AUTHOR_EMAIL: 'inventory@example.invalid',
        GIT_COMMITTER_NAME: 'Inventory Test',
        GIT_COMMITTER_EMAIL: 'inventory@example.invalid',
      },
    });
    expect(detached.status, detached.stderr).toBe(0);
    const nonAncestor = detached.stdout.trim();
    expect(nonAncestor).toMatch(/^[0-9a-f]{40}$/);
    const nonAncestorOverride = spawnSync('node', [GENERATOR], {
      ...opts,
      env: { ...process.env, ISSUE_3702_HEAD: nonAncestor },
    });
    expect(nonAncestorOverride.status).not.toBe(0);
    expect(nonAncestorOverride.stderr).toContain('ancestor of the current HEAD');

    const nonAncestorBaseline = join(REPO_ROOT, `.tmp-inventory-non-ancestor-${process.pid}.json`);
    const nonAncestorManifest = JSON.parse(JSON.stringify(manifest)) as Manifest;
    nonAncestorManifest.head = nonAncestor;
    nonAncestorManifest.provenance.head = nonAncestor;
    const withoutManifestSha = { ...(nonAncestorManifest as unknown as Record<string, unknown>) };
    delete withoutManifestSha.manifestSha256;
    nonAncestorManifest.manifestSha256 = sha256Hex(stableStringify(withoutManifestSha));
    writeFileSync(nonAncestorBaseline, `${JSON.stringify(nonAncestorManifest, null, 2)}\n`);
    try {
      const result = spawnSync('node', [GENERATOR, '--verify', '--out', nonAncestorBaseline], opts);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ancestor of the current HEAD');
    } finally {
      unlinkSync(nonAncestorBaseline);
    }

    const outsideOut = resolve(REPO_ROOT, '..', `.tmp-inventory-outside-${process.pid}.json`);
    const outsideWrite = spawnSync('node', [GENERATOR, '--write', '--out', outsideOut], opts);
    expect(outsideWrite.status).not.toBe(0);
    expect(existsSync(outsideOut)).toBe(false);
  });
});
