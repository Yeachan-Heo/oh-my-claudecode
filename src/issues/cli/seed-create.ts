#!/usr/bin/env node
import { GitHubProvider } from '../../providers/github.js';
import { createIssuesFromManifest, CreateOptions } from '../seed-create.js';

interface Args {
  manifestPath: string;
  auditPath: string;
  repo: string;
  dryRun: boolean;
  alsoMarkReady: boolean;
  milestone?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    manifestPath: '.omc/seed-issues/manifest.json',
    auditPath: '.omc/seed-issues/audit.log',
    dryRun: false,
    alsoMarkReady: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifestPath = argv[++i];
    else if (a === '--audit') out.auditPath = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--also-mark-ready') out.alsoMarkReady = true;
    else if (a === '--milestone') out.milestone = argv[++i];
  }
  if (!out.repo) throw new Error('seed-create: --repo <owner/name> is required');
  return out as Args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const provider = new GitHubProvider();
  const opts: CreateOptions = {
    manifestPath: args.manifestPath,
    auditPath: args.auditPath,
    repo: args.repo,
    dryRun: args.dryRun,
    alsoMarkReady: args.alsoMarkReady,
    milestone: args.milestone,
  };
  const result = createIssuesFromManifest(opts, provider, 'omc-seed-hash');
  process.stdout.write(`\nSummary: ${result.created} created, ${result.skipped} skipped, ${result.errors} failed\n`);
  if (result.created > 0) {
    process.stdout.write('Created issues:\n');
    for (const d of result.details) {
      if (d.status === 'created' && d.url) {
        process.stdout.write(`  #${d.issueNumber}: ${d.url}\n`);
      }
    }
  }
  process.exit(result.errors > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`seed-create: ${(err as Error).message}\n`);
  process.exit(2);
}
