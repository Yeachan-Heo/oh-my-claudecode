#!/usr/bin/env node

/**
 * verify-cli-shipped.mjs
 *
 * Verifies that the published npm package contains the required CLI entry points.
 * Run this before opening a PR to confirm neither bridge/cli.cjs nor dist/cli/index.js
 * was accidentally dropped from package.json#files.
 *
 * Usage:
 *   node scripts/verify-cli-shipped.mjs
 *
 * Exits 0 on success, 1 on failure with a descriptive error.
 * Skips cleanup on failure so the extracted tarball can be inspected manually.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REQUIRED_FILES = [
  'package/bridge/cli.cjs',
  'package/dist/cli/index.js',
];

function main() {
  const packDir = mkdtempSync(join(tmpdir(), 'omc-verify-pack-'));
  const extractDir = mkdtempSync(join(tmpdir(), 'omc-verify-extract-'));
  let failed = false;

  try {
    // Pack the tarball and get its filename via --json (works on npm 7+)
    console.log('Packing npm tarball...');
    const packJsonRaw = execFileSync(
      'npm',
      ['pack', '--pack-destination', packDir, '--json'],
      { encoding: 'utf-8', cwd: process.cwd() }
    ).trim();

    let packInfo;
    try {
      packInfo = JSON.parse(packJsonRaw);
    } catch {
      console.error('ERROR: Failed to parse npm pack --json output:');
      console.error(packJsonRaw);
      process.exit(1);
    }

    const filename = packInfo[0]?.filename;
    if (!filename) {
      console.error('ERROR: npm pack --json did not return a filename.');
      console.error(JSON.stringify(packInfo, null, 2));
      process.exit(1);
    }

    const tarball = join(packDir, filename);
    if (!existsSync(tarball)) {
      console.error(`ERROR: Expected tarball not found: ${tarball}`);
      process.exit(1);
    }

    console.log(`Packed: ${tarball}`);
    console.log('Extracting...');

    // -xzf is portable across macOS (BSD tar) and Linux (GNU tar)
    execFileSync('tar', ['-xzf', tarball, '-C', extractDir]);

    // Verify required files exist in the extracted package
    const missing = [];
    for (const required of REQUIRED_FILES) {
      const fullPath = join(extractDir, required);
      if (existsSync(fullPath)) {
        console.log(`  OK  ${required}`);
      } else {
        console.error(`  MISSING  ${required}`);
        missing.push(required);
      }
    }

    if (missing.length > 0) {
      console.error('\nERROR: Required CLI files are missing from the npm package:');
      for (const f of missing) {
        console.error(`  - ${f}`);
      }
      console.error('\nCheck package.json#files — ensure it includes "dist" and "bridge/cli.cjs".');
      console.error(`Extracted tarball left in: ${extractDir}`);
      failed = true;
      process.exit(1);
    }

    console.log('\nAll required CLI files are present in the npm package.');
  } finally {
    try { rmSync(packDir, { recursive: true, force: true }); } catch {}
    if (!failed) {
      try { rmSync(extractDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main();
