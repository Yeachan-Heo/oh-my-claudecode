import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseTeamDagHandoff, readTeamDagHandoffForLatestPlan } from '../dag-schema.js';

describe('dag-schema OMX parity adapter', () => {
  async function withTemp<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-team-dag-'));
    try {
      return await fn(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async function writePlanPair(cwd: string, slug: string, root: '.omc' | '.omx' = '.omc'): Promise<string> {
    const plansDir = join(cwd, root, 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, `prd-${slug}.md`), '# PRD\n');
    await writeFile(join(plansDir, `test-spec-${slug}.md`), '# Test Spec\n');
    return plansDir;
  }

  it('parses DAG nodes, worker policy, and rejects invalid dependencies/cycles', () => {
    expect(parseTeamDagHandoff({
      schema_version: 1,
      nodes: [
        { id: 'plan', subject: 'Plan', description: 'Plan work' },
        { id: 'impl', subject: 'Implement', description: 'Implement work', depends_on: ['plan'] },
      ],
      worker_policy: { requested_count: 2, count_source: 'plan-suggested' },
    }).nodes.map((node) => node.id)).toEqual(['plan', 'impl']);

    expect(() => parseTeamDagHandoff({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement', description: 'Implement work', depends_on: ['missing'] }],
    })).toThrow(/unknown node/);

    expect(() => parseTeamDagHandoff({
      schema_version: 1,
      nodes: [
        { id: 'a', subject: 'A', description: 'A', depends_on: ['b'] },
        { id: 'b', subject: 'B', description: 'B', depends_on: ['a'] },
      ],
    })).toThrow(/cycle/);
  });

  it('loads a matching Team DAG sidecar for the latest OMC PRD slug', async () => {
    await withTemp(async (cwd) => {
      const plansDir = await writePlanPair(cwd, 'alpha');
      await writeFile(join(plansDir, 'team-dag-alpha.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'impl', subject: 'Implement alpha', description: 'Implement alpha DAG' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.source).toBe('sidecar');
      expect(result.planSlug).toBe('alpha');
      expect(result.dag?.nodes[0]?.id).toBe('impl');
    });
  });

  it('accepts OMX plans directory as a compatibility source', async () => {
    await withTemp(async (cwd) => {
      const plansDir = await writePlanPair(cwd, 'omx-alpha', '.omx');
      await writeFile(join(plansDir, 'team-dag-omx-alpha.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'compat', subject: 'Compat', description: 'Compat DAG' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.source).toBe('sidecar');
      expect(result.planSlug).toBe('omx-alpha');
      expect(result.dag?.nodes[0]?.id).toBe('compat');
    });
  });

  it('does not overmatch sidecars for a different slug prefix', async () => {
    await withTemp(async (cwd) => {
      const plansDir = await writePlanPair(cwd, 'foo');
      await writeFile(join(plansDir, 'team-dag-foobar.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'wrong', subject: 'Wrong slug', description: 'Must not match foo' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.source).toBe('none');
      expect(result.planSlug).toBe('foo');
      expect(result.dag).toBeNull();
    });
  });

  it('prefers sidecar DAG over embedded PRD Team DAG Handoff block', async () => {
    await withTemp(async (cwd) => {
      const plansDir = join(cwd, '.omc', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-beta.md'), '# Beta\n\n## Team DAG Handoff\n```json\n{"schema_version":1,"nodes":[{"id":"markdown","subject":"Markdown","description":"Markdown DAG"}]}\n```\n');
      await writeFile(join(plansDir, 'test-spec-beta.md'), '# Beta Test\n');
      await writeFile(join(plansDir, 'team-dag-beta.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'sidecar', subject: 'Sidecar wins', description: 'Sidecar DAG' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.source).toBe('sidecar');
      expect(result.dag?.nodes[0]?.id).toBe('sidecar');
    });
  });

  it('reports multiple matching sidecars and chooses lexicographically latest', async () => {
    await withTemp(async (cwd) => {
      const plansDir = await writePlanPair(cwd, 'gamma');
      await writeFile(join(plansDir, 'team-dag-gamma-a.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'old', subject: 'Old', description: 'Old DAG' }],
      }));
      await writeFile(join(plansDir, 'team-dag-gamma-z.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'new', subject: 'New', description: 'New DAG' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.warning).toBe('multiple_matches');
      expect(result.dag?.nodes[0]?.id).toBe('new');
    });
  });

  it('does not load a DAG handoff when latest PRD lacks a matching test spec', async () => {
    await withTemp(async (cwd) => {
      const plansDir = join(cwd, '.omc', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-epsilon.md'), '# Epsilon\n');
      await writeFile(join(plansDir, 'test-spec-other.md'), '# Other Test\n');
      await writeFile(join(plansDir, 'team-dag-epsilon.json'), JSON.stringify({
        schema_version: 1,
        nodes: [{ id: 'impl', subject: 'Implement epsilon', description: 'Implement epsilon DAG' }],
      }));

      const result = readTeamDagHandoffForLatestPlan(cwd);
      expect(result.source).toBe('none');
      expect(result.dag).toBeNull();
      expect(result.error).toBe('missing_matching_test_spec');
    });
  });

  it('returns parse error metadata for malformed or mismatched DAG sidecars', async () => {
    await withTemp(async (cwd) => {
      const plansDir = await writePlanPair(cwd, 'zeta');
      await writeFile(join(plansDir, 'team-dag-zeta.json'), JSON.stringify({
        schema_version: 1,
        plan_slug: 'other',
        nodes: [{ id: 'impl', subject: 'Implement zeta', description: 'Implement zeta DAG' }],
      }));
      const mismatch = readTeamDagHandoffForLatestPlan(cwd);
      expect(mismatch.source).toBe('sidecar');
      expect(mismatch.dag).toBeNull();
      expect(mismatch.error).toMatch(/does not match/);

      await writeFile(join(plansDir, 'team-dag-zeta.json'), '{bad json');
      const malformed = readTeamDagHandoffForLatestPlan(cwd);
      expect(malformed.source).toBe('sidecar');
      expect(malformed.dag).toBeNull();
      expect(malformed.error).toMatch(/JSON|property/i);
    });
  });
});
