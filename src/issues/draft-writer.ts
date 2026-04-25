import { createHash, randomBytes } from 'node:crypto';
import {
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type IssueSource = 'docs' | 'idea';

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  milestone?: string;
  mode?: string;
  source: IssueSource;
  contentHash: string;
  frontmatter: Record<string, unknown>;
}

export interface ManifestEntry {
  seq?: number;
  title: string;
  draft_path: string;
  content_hash: string;
  status: 'draft' | 'created' | 'skipped' | 'error';
  issue_number?: number | null;
  issue_url?: string;
  source: IssueSource;
  source_file?: string;
  source_heading?: string;
  mode?: string;
  created_at?: string;
  error?: string;
  [key: string]: unknown;
}

export const SENTINEL_PREFIX_SEED = 'omc-seed-hash';
export const SENTINEL_PREFIX_CREATE = 'omc-create-hash';

export function computeContentHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized).digest('hex');
}

export function renderHashSentinel(hash: string, prefix: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`renderHashSentinel: hash must be 64-char lowercase hex, got ${hash.length} chars`);
  }
  return `<!-- ${prefix}:${hash} -->`;
}

export function generateNonce(byteLen = 4): string {
  return randomBytes(byteLen).toString('hex');
}

export function renderDraftToMarkdown(draft: IssueDraft): string {
  const sentinelPrefix =
    draft.source === 'docs' ? SENTINEL_PREFIX_SEED : SENTINEL_PREFIX_CREATE;
  const fm = renderFrontmatter(draft.frontmatter);
  const body = draft.body.replace(/\r\n/g, '\n').replace(/\s+$/g, '');
  const sentinel = renderHashSentinel(draft.contentHash, sentinelPrefix);
  return `${fm}\n\n${body}\n\n${sentinel}\n`;
}

function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${formatScalar(item)}`);
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (v == null) {
      lines.push(`${k}: ""`);
    } else {
      lines.push(`${k}: ${formatScalar(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function formatScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function writeDraftFile(
  draft: IssueDraft,
  outputDir: string,
  seq: number,
): string {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filename = `${String(seq).padStart(3, '0')}.md`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, renderDraftToMarkdown(draft), { encoding: 'utf-8' });
  return filepath;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional busy wait — sub-second backoff
  }
}

export function appendManifestEntry(
  manifestPath: string,
  entry: ManifestEntry,
): ManifestEntry {
  const dir = dirname(manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const existing: ManifestEntry[] = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[])
        : [];
      if (!Array.isArray(existing)) {
        throw new Error(`appendManifestEntry: manifest at ${manifestPath} is not an array`);
      }
      const seqs = existing
        .map((e) => e.seq)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const nextSeq = seqs.length > 0 ? Math.max(...seqs) + 1 : 1;
      const finalEntry: ManifestEntry = { ...entry, seq: entry.seq ?? nextSeq };
      existing.push(finalEntry);
      const tmp = `${manifestPath}.tmp.${process.pid}.${generateNonce(3)}`;
      writeFileSync(tmp, JSON.stringify(existing, null, 2), { encoding: 'utf-8' });
      renameSync(tmp, manifestPath);
      return finalEntry;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) sleepSync(100 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`appendManifestEntry: failed after retries: ${String(lastErr)}`);
}

export function readManifest(manifestPath: string): ManifestEntry[] {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
    return Array.isArray(data) ? (data as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}

export function updateManifestEntry(
  manifestPath: string,
  seq: number,
  patch: Partial<ManifestEntry>,
): ManifestEntry | null {
  const dir = dirname(manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const existing = readManifest(manifestPath);
      const idx = existing.findIndex((e) => e.seq === seq);
      if (idx < 0) return null;
      const updated: ManifestEntry = { ...existing[idx], ...patch };
      existing[idx] = updated;
      const tmp = `${manifestPath}.tmp.${process.pid}.${generateNonce(3)}`;
      writeFileSync(tmp, JSON.stringify(existing, null, 2), { encoding: 'utf-8' });
      renameSync(tmp, manifestPath);
      return updated;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) sleepSync(100 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`updateManifestEntry: failed after retries: ${String(lastErr)}`);
}

export function appendAuditLine(auditPath: string, line: string): void {
  const dir = dirname(auditPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const stamped = `${ts} ${line.replace(/\r?\n/g, ' ')}\n`;
  if (existsSync(auditPath)) {
    const prev = readFileSync(auditPath, 'utf-8');
    writeFileSync(auditPath, prev + stamped, { encoding: 'utf-8' });
  } else {
    writeFileSync(auditPath, stamped, { encoding: 'utf-8' });
  }
}
