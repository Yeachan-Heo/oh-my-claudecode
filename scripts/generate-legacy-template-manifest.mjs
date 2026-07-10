#!/usr/bin/env node
/**
 * Regenerate (or verify) the legacy pre-marker CLAUDE.md template manifest from
 * upstream git history. History-dependent maintenance/CI helper — the shipped
 * detector reads only the checked-in constants, so this never runs at install
 * time.
 *
 * Usage:
 *   node scripts/generate-legacy-template-manifest.mjs           # write manifest
 *   node scripts/generate-legacy-template-manifest.mjs --check   # exit 1 if stale
 *
 * A "legacy template" is any revision of docs/CLAUDE.md that predates the OMC
 * marker mechanism (i.e. contains no `<!-- OMC:START -->`). Normalization is
 * EOL-only (CRLF/CR -> LF, drop a single trailing newline) to match
 * normalizeTemplateLines() in src/installer/claude-md-merge.ts.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(
  REPO_ROOT,
  'src',
  'installer',
  '__tests__',
  'fixtures',
  'legacy-template-manifest.json',
);
const OMC_START_MARKER = '<!-- OMC:START -->';

function run(command) {
  return execSync(command, { cwd: REPO_ROOT, maxBuffer: 1 << 28 }).toString();
}

function normalizeTemplateLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function generate() {
  const commits = run('git log --all --format=%H -- docs/CLAUDE.md').trim().split('\n').filter(Boolean);
  const blobs = new Set();
  for (const commit of commits) {
    try {
      const blob = run(`git rev-parse ${commit}:docs/CLAUDE.md`).trim();
      if (blob) blobs.add(blob);
    } catch {
      // Path may not exist at that revision; ignore.
    }
  }

  const bySha = new Map();
  for (const blob of blobs) {
    const content = run(`git cat-file -p ${blob}`);
    if (content.includes(OMC_START_MARKER)) continue; // markerless (pre-marker) only
    const lines = normalizeTemplateLines(content);
    const sha256 = sha256Hex(lines.join('\n'));
    if (!bySha.has(sha256)) {
      bySha.set(sha256, {
        blob: blob.slice(0, 12),
        lineCount: lines.length,
        sha256,
        heading: lines[0],
        markerAbsence: true,
      });
    }
  }

  return [...bySha.values()].sort((a, b) => a.lineCount - b.lineCount || a.sha256.localeCompare(b.sha256));
}

const manifest = generate();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(MANIFEST_PATH, 'utf-8');
  if (current !== serialized) {
    process.stderr.write(
      'Legacy template manifest is stale. Run: node scripts/generate-legacy-template-manifest.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write(`Legacy template manifest is up to date (${manifest.length} entries).\n`);
} else {
  writeFileSync(MANIFEST_PATH, serialized);
  process.stdout.write(`Wrote ${manifest.length} entries to ${MANIFEST_PATH}\n`);
}
