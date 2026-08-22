#!/usr/bin/env tsx
/**
 * Build/verify deterministic prompt SSOT projections (epic #3698 / issue #3704).
 *
 * Usage:
 *   tsx scripts/build-prompt-ssot.ts           regenerate generated/prompt-ssot/*.md
 *   tsx scripts/build-prompt-ssot.ts --check   fail (exit 1) if committed projections are stale
 *
 * The --check mode is the "build fails on stale projections" gate from plan
 * §6.2: any section/manifest edit without regeneration produces a digest
 * mismatch and a non-zero exit.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeAll } from '../src/agents/prompt-ssot/compose.js';
import { PROMPT_SSOT_MANIFEST } from '../src/agents/prompt-ssot/manifest.js';
import { PROMPT_SECTIONS } from '../src/agents/prompt-ssot/sections.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'generated', 'prompt-ssot');
const checkMode = process.argv.includes('--check');

function main(): number {
  const composed = composeAll(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS);
  const stale: string[] = [];

  if (!checkMode) mkdirSync(OUT_DIR, { recursive: true });

  for (const projection of composed) {
    const path = join(OUT_DIR, `${projection.id}.md`);
    let current: string | undefined;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== projection.fileText) {
      stale.push(projection.id);
      if (!checkMode) writeFileSync(path, projection.fileText);
    }
  }

  if (checkMode) {
    let committed: string[] = [];
    try {
      committed = readdirSync(OUT_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''));
    } catch {
      committed = [];
    }
    const expected = composed.map((c) => c.id);
    const unexpected = committed.filter((id) => !expected.includes(id));
    if (stale.length > 0 || unexpected.length > 0) {
      if (stale.length > 0) {
        console.error(`prompt-ssot: stale projections: ${stale.join(', ')}`);
      }
      if (unexpected.length > 0) {
        console.error(`prompt-ssot: unexpected committed projections: ${unexpected.join(', ')}`);
      }
      console.error('prompt-ssot: run `npm run prompt-ssot:build` to regenerate.');
      return 1;
    }
    console.log(`prompt-ssot: ${composed.length} projections fresh (sourceRevision ${PROMPT_SSOT_MANIFEST.sourceRevision}).`);
    return 0;
  }

  for (const projection of composed) {
    console.log(`prompt-ssot: wrote generated/prompt-ssot/${projection.id}.md sha256=${projection.metadata.digest.slice(0, 12)}…`);
  }
  return 0;
}

process.exit(main());
