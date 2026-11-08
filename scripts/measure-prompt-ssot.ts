#!/usr/bin/env tsx
/**
 * Measured acceptance evidence for issue #3704 (epic #3698 §6.2/§7).
 *
 * Emits docs/design/issue-3704-prompt-ssot/measurements.json with:
 * - baseline repeated-clause stats over the legacy prompt corpus
 *   (CLAUDE.md + docs/CLAUDE.md + .github/CLAUDE.md + agents/*.md), where
 *   normative clauses are hand-copied across projections
 * - SSOT repeated-clause stats over the canonical section corpus, where
 *   every normative clause is stored exactly once
 * - repeated-token reduction percentage (target band 35-50% minimum)
 * - projection drift between composed bodies and committed generated
 *   projections (target <5%; the build gate enforces 0)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeAll } from '../src/agents/prompt-ssot/compose.js';
import { PROMPT_SSOT_MANIFEST } from '../src/agents/prompt-ssot/manifest.js';
import { corpusStats, projectionDrift } from '../src/agents/prompt-ssot/metrics.js';
import { PROMPT_SECTIONS } from '../src/agents/prompt-ssot/sections.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'docs', 'design', 'issue-3704-prompt-ssot');
const GENERATED_DIR = join(REPO_ROOT, 'generated', 'prompt-ssot');

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function legacyCorpus(): { files: string[]; texts: string[] } {
  const files: string[] = [];
  for (const rel of ['CLAUDE.md', 'docs/CLAUDE.md', '.github/CLAUDE.md']) {
    if (existsSync(join(REPO_ROOT, rel))) files.push(rel);
  }
  const agentsDir = join(REPO_ROOT, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()) {
      files.push(`agents/${f}`);
    }
  }
  return { files, texts: files.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')) };
}

function main(): number {
  const legacy = legacyCorpus();
  const baseline = corpusStats(legacy.texts);
  const ssot = corpusStats(PROMPT_SECTIONS.map((s) => s.body));

  const composed = composeAll(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS);
  const drifts: Record<string, number> = {};
  let maxDrift = 0;
  for (const projection of composed) {
    const committed = readIfExists(join(GENERATED_DIR, `${projection.id}.md`));
    // Strip the metadata header before comparing bodies.
    const committedBody = committed?.replace(/^<!-- PROMPT-SSOT:GENERATED[\s\S]*?-->\n\n/, '');
    const drift = committedBody === undefined ? 1 : projectionDrift(projection.body, committedBody);
    drifts[projection.id] = drift;
    if (drift > maxDrift) maxDrift = drift;
  }

  const repeatedTokenReduction =
    baseline.repeatedTokens === 0
      ? 0
      : (baseline.repeatedTokens - ssot.repeatedTokens) / baseline.repeatedTokens;

  const report = {
    schemaVersion: 1,
    issue: 3704,
    epic: 3698,
    sourceRevision: PROMPT_SSOT_MANIFEST.sourceRevision,
    measuredAt: new Date().toISOString(),
    baselineCorpus: legacy.files,
    baseline,
    ssot,
    repeatedTokenReduction: Number(repeatedTokenReduction.toFixed(4)),
    repeatedClauseRatioReduction: Number(
      (baseline.repeatedClauseRatio - ssot.repeatedClauseRatio).toFixed(4),
    ),
    projectionDrift: drifts,
    maxProjectionDrift: Number(maxDrift.toFixed(4)),
    targets: { repeatedTokenReductionMin: 0.35, maxProjectionDrift: 0.05 },
    pass: repeatedTokenReduction >= 0.35 && maxDrift < 0.05,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, repeatedTokenReduction: report.repeatedTokenReduction, maxProjectionDrift: report.maxProjectionDrift }, null, 2));
  return report.pass ? 0 : 1;
}

process.exit(main());
