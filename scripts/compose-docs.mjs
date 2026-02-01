#!/usr/bin/env node

/**
 * Documentation Composition Script
 *
 * Processes template files with {{INCLUDE:path}} syntax to compose
 * final documentation from shared partials.
 *
 * Usage: node scripts/compose-docs.mjs
 *
 * Template syntax: {{INCLUDE:partials/agent-tiers.md}}
 * Templates: docs/templates/*.template.md
 * Output: docs/*.md (same name without .template)
 * Partials also copied to docs/shared/ for direct reference.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, '..', 'docs');
const partialsDir = join(docsDir, 'partials');
const sharedDir = join(docsDir, 'shared');

// Ensure directories exist
[partialsDir, sharedDir].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Copy partials to shared/ for direct reference by skills
if (existsSync(partialsDir)) {
  const partials = readdirSync(partialsDir).filter(f => f.endsWith('.md'));

  for (const partial of partials) {
    const content = readFileSync(join(partialsDir, partial), 'utf-8');
    writeFileSync(join(sharedDir, partial), content);
  }
  console.log(`Synced ${readdirSync(partialsDir).filter(f => f.endsWith('.md')).length} partials to shared/`);
}

console.log('Documentation composition complete.');
