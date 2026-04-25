import { GitHubProvider } from '../providers/github.js';
import {
  ManifestEntry,
  appendAuditLine,
  readManifest,
  updateManifestEntry,
} from './draft-writer.js';
import { readFileSync, existsSync } from 'node:fs';

export interface CreateOptions {
  manifestPath: string;
  auditPath: string;
  repo: string;
  dryRun?: boolean;
  alsoMarkReady?: boolean;
  milestone?: string;
}

export interface CreateResult {
  created: number;
  skipped: number;
  errors: number;
  details: Array<{ seq: number; status: string; issueNumber?: number; url?: string; error?: string }>;
}

export function checkExistingIssue(
  hash: string,
  provider: GitHubProvider,
  repo: string,
  prefix: string,
): { number: number; url: string } | null {
  const matches = provider.searchIssues(hash, { repo, state: 'all' });
  for (const m of matches) {
    if (m.body.includes(`${prefix}:${hash}`)) {
      return { number: m.number, url: m.url };
    }
  }
  return null;
}

export function ensureLabelsExist(
  labels: string[],
  provider: GitHubProvider,
  repo: string,
): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const name of new Set(labels)) {
    if (!name) continue;
    const ok = provider.ensureLabel(name, { repo });
    if (!ok) failed.push(name);
  }
  return { ok: failed.length === 0, failed };
}

export function ensureMilestoneExists(
  name: string,
  provider: GitHubProvider,
  repo: string,
): number | null {
  return provider.ensureMilestone(name, { repo });
}

interface CreateContext {
  provider: GitHubProvider;
  options: CreateOptions;
  hashSentinelPrefix: string;
}

function processEntry(entry: ManifestEntry, ctx: CreateContext): {
  status: 'created' | 'skipped' | 'error';
  issueNumber?: number;
  url?: string;
  error?: string;
} {
  const { provider, options, hashSentinelPrefix } = ctx;
  if (entry.status === 'created' && entry.issue_number) {
    return { status: 'skipped', issueNumber: entry.issue_number, url: entry.issue_url };
  }
  const existing = checkExistingIssue(entry.content_hash, provider, options.repo, hashSentinelPrefix);
  if (existing) {
    return { status: 'skipped', issueNumber: existing.number, url: existing.url };
  }
  if (!entry.draft_path || !existsSync(entry.draft_path)) {
    return { status: 'error', error: `draft file missing: ${entry.draft_path}` };
  }
  if (options.dryRun) return { status: 'skipped' };
  const body = readFileSync(entry.draft_path, 'utf-8');
  const result = provider.createIssue({
    title: entry.title,
    body,
    labels: extractLabelsFromBody(body),
    milestone: extractMilestoneFromBody(body) ?? options.milestone,
    repo: options.repo,
  });
  if (!result) return { status: 'error', error: 'gh issue create returned no URL' };
  return { status: 'created', issueNumber: result.number, url: result.url };
}

function extractLabelsFromBody(body: string): string[] {
  const fm = parseFrontmatter(body);
  const labels = fm['labels'];
  if (Array.isArray(labels)) return labels.map(String);
  return [];
}

function extractMilestoneFromBody(body: string): string | undefined {
  const fm = parseFrontmatter(body);
  const m = fm['milestone'];
  if (typeof m === 'string' && m.length > 0) return m;
  return undefined;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const raw of m[1].split('\n')) {
    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem && currentKey && currentList) {
      currentList.push(stripQuotes(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (kv) {
      const [, key, val] = kv;
      if (val.trim() === '') {
        currentKey = key;
        currentList = [];
        out[key] = currentList;
      } else {
        currentKey = null;
        currentList = null;
        out[key] = stripQuotes(val.trim());
      }
    }
  }
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length === 0) delete out[k];
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function createIssuesFromManifest(
  options: CreateOptions,
  provider: GitHubProvider = new GitHubProvider(),
  hashSentinelPrefix = 'omc-seed-hash',
): CreateResult {
  if (!provider.checkWriteScope(options.repo)) {
    throw new Error(`createIssuesFromManifest: missing write scope for repo ${options.repo}`);
  }
  const entries = readManifest(options.manifestPath);
  const total = entries.length;
  const result: CreateResult = { created: 0, skipped: 0, errors: 0, details: [] };
  if (options.milestone) ensureMilestoneExists(options.milestone, provider, options.repo);
  const allLabels = new Set<string>();
  for (const e of entries) {
    const body = e.draft_path && existsSync(e.draft_path)
      ? readFileSync(e.draft_path, 'utf-8')
      : '';
    extractLabelsFromBody(body).forEach((l) => allLabels.add(l));
  }
  const labelResult = ensureLabelsExist([...allLabels], provider, options.repo);
  if (!labelResult.ok) {
    process.stderr.write(`warning: failed to ensure labels: ${labelResult.failed.join(', ')}\n`);
  }
  const ctx: CreateContext = { provider, options, hashSentinelPrefix };
  entries.forEach((entry, idx) => {
    const seq = entry.seq ?? idx + 1;
    const outcome = processEntry(entry, ctx);
    const labelText = entry.title ?? `<seq ${seq}>`;
    if (outcome.status === 'created') {
      result.created++;
      process.stdout.write(`[${idx + 1}/${total}] Created issue #${outcome.issueNumber} -- ${labelText}\n`);
      updateManifestEntry(options.manifestPath, seq, {
        status: 'created',
        issue_number: outcome.issueNumber,
        issue_url: outcome.url,
      });
      appendAuditLine(
        options.auditPath,
        `CREATE gh issue create --title "${entry.title}" --body-file ${entry.draft_path} => #${outcome.issueNumber}`,
      );
    } else if (outcome.status === 'skipped') {
      result.skipped++;
      process.stdout.write(`[${idx + 1}/${total}] Skipped (existing) -- ${labelText}\n`);
      if (outcome.issueNumber) {
        updateManifestEntry(options.manifestPath, seq, {
          status: 'skipped',
          issue_number: outcome.issueNumber,
          issue_url: outcome.url,
        });
        appendAuditLine(
          options.auditPath,
          `SKIP hash=${entry.content_hash} matches existing issue #${outcome.issueNumber}`,
        );
      }
    } else {
      result.errors++;
      process.stdout.write(`[${idx + 1}/${total}] FAILED -- ${labelText}: ${outcome.error}\n`);
      updateManifestEntry(options.manifestPath, seq, {
        status: 'error',
        error: outcome.error,
      });
      appendAuditLine(
        options.auditPath,
        `ERROR seq=${seq} title="${entry.title}" error="${outcome.error}"`,
      );
    }
    result.details.push({
      seq,
      status: outcome.status,
      issueNumber: outcome.issueNumber,
      url: outcome.url,
      error: outcome.error,
    });
  });
  return result;
}
