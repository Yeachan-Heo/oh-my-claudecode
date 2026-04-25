#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { GitHubProvider } from '../../providers/github.js';
import {
  appendAuditLine,
  readManifest,
  updateManifestEntry,
} from '../draft-writer.js';
import { checkExistingIssue } from '../seed-create.js';

interface Args {
  draftPath: string;
  manifestPath: string;
  auditPath: string;
  repo: string;
  force: boolean;
  fromBridge: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    manifestPath: '.omc/created-issues/manifest.json',
    auditPath: '.omc/created-issues/audit.log',
    force: false,
    fromBridge: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') out.draftPath = argv[++i];
    else if (a === '--manifest') out.manifestPath = argv[++i];
    else if (a === '--audit') out.auditPath = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--from-bridge') out.fromBridge = true;
  }
  if (!out.draftPath) throw new Error('issue-create: --draft <path> is required');
  if (!out.repo) throw new Error('issue-create: --repo <owner/name> is required');
  return out as Args;
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return {};
  const out: Record<string, string | string[]> = {};
  let key: string | null = null;
  let list: string[] | null = null;
  for (const raw of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && key && list) {
      list.push(stripQuotes(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    if (kv[2].trim() === '') {
      key = kv[1];
      list = [];
      out[kv[1]] = list;
    } else {
      key = null;
      list = null;
      out[kv[1]] = stripQuotes(kv[2].trim());
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.draftPath)) {
    process.stderr.write(`issue-create: draft not found: ${args.draftPath}\n`);
    process.exit(3);
  }
  const provider = new GitHubProvider();
  if (!provider.checkWriteScope(args.repo)) {
    process.stderr.write(`issue-create: missing write scope for ${args.repo}\n`);
    process.exit(2);
  }
  const draftContent = readFileSync(args.draftPath, 'utf-8');
  const fm = parseFrontmatter(draftContent);
  const title = typeof fm['title'] === 'string' ? fm['title'] : '';
  const contentHash = typeof fm['content_hash'] === 'string' ? fm['content_hash'] : '';
  const labels = Array.isArray(fm['labels']) ? fm['labels'] as string[] : [];
  const milestone = typeof fm['milestone'] === 'string' && fm['milestone'].length > 0 ? fm['milestone'] as string : undefined;
  if (!title || !contentHash) {
    process.stderr.write('issue-create: draft missing title or content_hash in frontmatter\n');
    process.exit(3);
  }
  if (!args.force) {
    const existing = checkExistingIssue(contentHash, provider, args.repo, 'omc-create-hash');
    if (existing) {
      process.stderr.write(`Issue already exists: #${existing.number} (${existing.url}). Use --force to create a duplicate (not recommended).\n`);
      process.exit(4);
    }
  }
  for (const label of labels) {
    provider.ensureLabel(label, { repo: args.repo });
  }
  const result = provider.createIssue({
    title,
    body: draftContent,
    labels,
    milestone,
    repo: args.repo,
  });
  if (!result) {
    process.stderr.write('issue-create: gh issue create failed\n');
    const entries = readManifest(args.manifestPath);
    const match = entries.find((e) => e.content_hash === contentHash);
    if (match?.seq != null) {
      updateManifestEntry(args.manifestPath, match.seq, {
        status: 'error',
        error: 'gh issue create failed',
      });
    }
    process.exit(5);
  }
  const entries = readManifest(args.manifestPath);
  const match = entries.find((e) => e.content_hash === contentHash);
  if (match?.seq != null) {
    updateManifestEntry(args.manifestPath, match.seq, {
      status: 'created',
      issue_number: result.number,
      issue_url: result.url,
      draft_path: args.draftPath,
    });
  }
  appendAuditLine(
    args.auditPath,
    `CREATE gh issue create --title "${title}" --body-file ${args.draftPath} => #${result.number}`,
  );
  process.stdout.write(JSON.stringify({
    ok: true,
    issue_number: result.number,
    issue_url: result.url,
    from_bridge: args.fromBridge,
  }) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`issue-create: ${(err as Error).message}\n`);
  process.exit(1);
}
