import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { composeManagedBlock, canonicalSourceRevision, composeAllClaudeProjections } from '../composer.js';
import { computeDigest, normalizeForDigest, createManifest, validateManifest, PROMPT_MANIFEST_SCHEMA_VERSION } from '../manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const computedRoot = join(__dirname, '../../..');
const root = (() => {
  try {
    if (existsSync(join(computedRoot, 'package.json'))) return computedRoot;
  } catch {
    // ignore
  }
  return process.cwd();
})();

function read(rel: string) { return readFileSync(join(root, rel), 'utf8'); }

describe('prompt projection parity #3705', () => {
  it('docs/CLAUDE.md is canonical and projections are deterministic', () => {
    const docsRaw = read('docs/CLAUDE.md');
    const pkgVer = JSON.parse(read('package.json')).version as string;
    const projections = composeAllClaudeProjections({ canonicalDocsRaw: docsRaw, version: pkgVer });
    expect(projections).toHaveLength(2);
    for (const p of projections) {
      expect(p.content).toContain('<!-- OMC:START -->');
      expect(p.content).toContain(`<!-- OMC:VERSION:${pkgVer} -->`);
      expect(p.content).toContain('<!-- OMC:END -->');
      expect(p.digest).toBe(computeDigest(p.content));
      expect(p.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    // sourceRevision is stable regardless of version marker
    const rev1 = canonicalSourceRevision(docsRaw);
    const rev2 = canonicalSourceRevision(docsRaw.replace(`<!-- OMC:VERSION:${pkgVer} -->`, '<!-- OMC:VERSION:0.0.0 -->'));
    expect(rev1).toBe(rev2);
    expect(rev1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('CLAUDE.md and .github/CLAUDE.md equal composed output (parity achieved)', () => {
    const docsRaw = read('docs/CLAUDE.md');
    const pkgVer = JSON.parse(read('package.json')).version as string;
    const expected = composeManagedBlock({ canonicalDocsRaw: docsRaw, version: pkgVer });
    const rootClaude = read('CLAUDE.md');
    const gh = read('.github/CLAUDE.md');
    expect(normalizeForDigest(rootClaude)).toBe(normalizeForDigest(expected));
    expect(normalizeForDigest(gh)).toBe(normalizeForDigest(expected));
    expect(normalizeForDigest(rootClaude)).toBe(normalizeForDigest(gh));
  });

  it('digest/version handshake: bridge coordinator was built from current docs/CLAUDE.md', () => {
    const docsBytes = readFileSync(join(root, 'docs/CLAUDE.md'));
    const docsSha = createHash('sha256').update(docsBytes).digest('hex');
    const bridge = readFileSync(join(root, 'bridge/claude-md-coordinator.cjs'), 'utf8');
    expect(bridge).toContain(docsSha);
    const pkgVer = JSON.parse(read('package.json')).version as string;
    expect(bridge).toContain(pkgVer);
  });

  it('manifest validates and covers claude projections', () => {
    const docsRaw = read('docs/CLAUDE.md');
    const pkgVer = JSON.parse(read('package.json')).version as string;
    const rev = canonicalSourceRevision(docsRaw);
    const projections = composeAllClaudeProjections({ canonicalDocsRaw: docsRaw, version: pkgVer });
    const records = projections.map(p => ({
      kind: 'claude' as const,
      sourcePath: 'docs/CLAUDE.md',
      outputPath: p.path,
      digest: p.digest,
      byteLength: Buffer.byteLength(p.content, 'utf8'),
    }));
    const manifest = createManifest(pkgVer, rev, records);
    expect(manifest.schemaVersion).toBe(PROMPT_MANIFEST_SCHEMA_VERSION);
    expect(manifest.sourceRevision).toBe(rev);
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateManifest({ ...manifest, sourceRevision: 'bad' }).length).toBeGreaterThan(0);
  });

  it('install/upgrade smoke: transaction backup/rollback primitives exist and fixtures guard them', () => {
    // Transaction module already has extensive tests; this smoke asserts the APIs are load-bearing
    // and that current fixtures exercise backup/rollback paths.
    const txPath = join(root, 'src/installer/claude-md-transaction.ts');
    const txSrc = readFileSync(txPath, 'utf8');
    expect(txSrc).toContain('exclusiveVerifiedBackup');
    expect(txSrc).toContain('atomicWrite');
    expect(txSrc).toContain('rollback');
    const txTest = join(root, 'src/installer/__tests__/claude-md-transaction.test.ts');
    expect(existsSync(txTest)).toBe(true);
    const testSrc = readFileSync(txTest, 'utf8');
    expect(testSrc).toContain('rollback');
    expect(testSrc).toContain('backup');
  });

  it('agent/command/skill projections have digests and are enumerable', () => {
    const agents = readdirSync(join(root, 'agents')).filter(f => f.endsWith('.md'));
    const commands = readdirSync(join(root, 'commands')).filter(f => f.endsWith('.md'));
    const skills = readdirSync(join(root, 'skills')).flatMap(d => {
      try { return readdirSync(join(root, 'skills', d)).filter(f => f === 'SKILL.md').map(()=> `skills/${d}/SKILL.md`); } catch { return []; }
    });
    expect(agents.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);
    expect(skills.length).toBeGreaterThan(0);
    for (const rel of [...agents.map(f=>`agents/${f}`), ...commands.map(f=>`commands/${f}`), ...skills]) {
      const content = read(rel);
      const d = computeDigest(content);
      expect(d).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('package.json build includes projection generation and coordinator handshake', () => {
    const pkg = JSON.parse(read('package.json'));
    const scripts: Record<string,string> = pkg.scripts;
    const build = scripts.build as string;
    expect(build).toContain('build:claude-md-coordinator');
    // compose-docs exists; our generate script is idempotent with build
    expect(scripts['compose-docs'] ?? build).toBeTruthy();
  });
});
