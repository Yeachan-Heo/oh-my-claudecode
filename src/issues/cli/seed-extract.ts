#!/usr/bin/env node
import {
  extractIssuesFromDocs,
  writeDraftsAndManifest,
  ExtractOptions,
} from '../seed-extract.js';

interface Args {
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  docs: string[];
  milestone?: string;
  alsoMarkReady: boolean;
  maxIssues?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    rootDir: process.cwd(),
    outputDir: '.omc/seed-issues',
    manifestPath: '.omc/seed-issues/manifest.json',
    docs: [],
    alsoMarkReady: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.rootDir = argv[++i];
    else if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--manifest') out.manifestPath = argv[++i];
    else if (a === '--docs') out.docs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--milestone') out.milestone = argv[++i];
    else if (a === '--also-mark-ready') out.alsoMarkReady = true;
    else if (a === '--max-issues') out.maxIssues = parseInt(argv[++i], 10);
  }
  if (!out.docs || out.docs.length === 0) {
    out.docs = [
      'docs/BASES-PRD.md',
      'docs/mock-ups/bases-navigation-revamp/README.md',
      'docs/mock-ups/planning-architecture',
      'docs/mock-ups/record-detail-full-page/README.md',
      'README.md',
    ];
  }
  return out as Args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const opts: ExtractOptions = {
    rootDir: args.rootDir,
    outputDir: args.outputDir,
    manifestPath: args.manifestPath,
    milestone: args.milestone,
    alsoMarkReady: args.alsoMarkReady,
    maxIssues: args.maxIssues,
  };
  const drafts = extractIssuesFromDocs(args.docs, opts);
  const result = writeDraftsAndManifest(drafts, opts);
  process.stdout.write(JSON.stringify({
    ok: true,
    drafts: result.manifestEntries.length,
    manifest: opts.manifestPath,
    output_dir: opts.outputDir,
  }) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`seed-extract: ${(err as Error).message}\n`);
  process.exit(1);
}
