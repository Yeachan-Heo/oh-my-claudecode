#!/usr/bin/env tsx
/**
 * Release Automation Script
 *
 * Automates version bumping, changelog generation, and release notes creation.
 * Uses merged PR metadata when available so changelog content, PR counts,
 * and contributors all reflect the same release dataset.
 *
 * Usage:
 *   npm run release -- patch              # Bump patch version
 *   npm run release -- minor              # Bump minor version
 *   npm run release -- major              # Bump major version
 *   npm run release -- 4.9.0              # Set explicit version
 *   npm run release -- patch --dry-run    # Preview without writing
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  type ReleasePullRequest,
  type ReleaseNoteEntry,
  extractPullRequestNumbers,
  isReleasePullRequest,
  deriveContributorLogins,
  buildReleaseNoteEntriesFromPullRequests,
  categorizeReleaseNoteEntries,
  generateChangelog,
  generateReleaseBody,
} from '../src/lib/release-generation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DEFAULT_REPO_SLUG = 'Yeachan-Heo/oh-my-claudecode';
const REPO_SLUG = process.env.GITHUB_REPOSITORY || DEFAULT_REPO_SLUG;
const REPO_URL = `https://github.com/${REPO_SLUG}`;
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

// ── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function clr(text: string, code: string): string {
  return `${code}${text}${c.reset}`;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ParsedCommit {
  hash: string;
  type: string;
  scope: string;
  description: string;
  prNumber: string | null;
  raw: string;
}

interface GitHubPullRequestResponse {
  title: string;
  user?: { login?: string | null } | null;
  head?: { ref?: string | null } | null;
}

interface GitHubCompareResponse {
  commits?: Array<{
    author?: { login?: string | null } | null;
  }>;
}

// ── Version helpers ─────────────────────────────────────────────────────────

function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  return pkg.version;
}

function getLatestTag(): string {
  try {
    return execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;

  const [major, minor, patch] = current.split('.').map(Number);
  switch (bump) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: throw new Error(`Invalid bump type: ${bump}. Use patch, minor, major, or X.Y.Z`);
  }
}

// ── Git helpers ─────────────────────────────────────────────────────────────

function getGitLog(tag: string, format: string, flags: string[] = []): string[] {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const cmd = ['git', 'log', range, `--format=${JSON.stringify(format)}`, ...flags].join(' ');
  const raw = execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
  return raw ? raw.split('\n') : [];
}

function getCommitLinesSinceTag(tag: string): string[] {
  return getGitLog(tag, '%H|%s');
}

function getNonMergeCommitLinesSinceTag(tag: string): string[] {
  return getGitLog(tag, '%H|%s', ['--no-merges']);
}

function getHeadSha(): string {
  return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
}

// ── Commit / PR parsing ─────────────────────────────────────────────────────

function parseCommit(line: string): ParsedCommit | null {
  const [hash, ...rest] = line.split('|');
  const raw = rest.join('|');

  if (!raw) return null;
  if (raw.startsWith('Merge ')) return null;
  if (raw.match(/^chore\(release\)/i)) return null;

  const conventionalMatch = raw.match(/^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?:\s*(?<desc>.+)$/);
  if (!conventionalMatch?.groups) return null;

  const prMatch = raw.match(/\(#(\d+)\)/);

  return {
    hash: hash.trim(),
    type: conventionalMatch.groups.type,
    scope: conventionalMatch.groups.scope || '',
    description: conventionalMatch.groups.desc.replace(/\s*\(#\d+\)$/, '').trim(),
    prNumber: prMatch ? prMatch[1] : null,
    raw,
  };
}

function toReleaseNoteEntryFromCommit(commit: ParsedCommit): ReleaseNoteEntry {
  return {
    type: commit.type,
    scope: commit.scope,
    description: commit.description,
    prNumber: commit.prNumber,
  };
}


// ── GitHub metadata helpers ─────────────────────────────────────────────────

function getGitHubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'oh-my-claudecode-release-script',
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  return headers;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: getGitHubApiHeaders() });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

function getRepoApiPath(): string {
  return REPO_SLUG
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

async function fetchPullRequestMetadata(prNumbers: string[]): Promise<ReleasePullRequest[]> {
  const repoPath = getRepoApiPath();
  const records = await Promise.all(prNumbers.map(async number => {
    const data = await fetchJson<GitHubPullRequestResponse>(
      `${GITHUB_API_URL}/repos/${repoPath}/pulls/${encodeURIComponent(number)}`
    );

    if (!data) return null;

    return {
      number,
      title: data.title,
      author: data.user?.login ?? null,
      headRefName: data.head?.ref ?? null,
    } satisfies ReleasePullRequest;
  }));

  return records.filter((record): record is ReleasePullRequest => record !== null);
}

async function fetchCompareCommitAuthors(prevTag: string): Promise<string[]> {
  if (!prevTag) return [];

  const repoPath = getRepoApiPath();
  const headRef = process.env.GITHUB_SHA || getHeadSha();
  const data = await fetchJson<GitHubCompareResponse>(
    `${GITHUB_API_URL}/repos/${repoPath}/compare/${encodeURIComponent(prevTag)}...${encodeURIComponent(headRef)}`
  );

  return (data?.commits ?? [])
    .map(commit => commit.author?.login ?? null)
    .filter((author): author is string => Boolean(author));
}

// ── Version file bumping ────────────────────────────────────────────────────

function bumpVersionFiles(newVersion: string, dryRun: boolean): string[] {
  const changes: string[] = [];

  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (pkg.version !== newVersion) {
    pkg.version = newVersion;
    if (!dryRun) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    changes.push(`package.json: ${pkg.version} → ${newVersion}`);
  }

  const pluginPath = join(ROOT, '.claude-plugin/plugin.json');
  if (existsSync(pluginPath)) {
    const content = readFileSync(pluginPath, 'utf-8');
    const updated = content.replace(/"version":\s*"[^"]*"/, `"version": "${newVersion}"`);
    if (content !== updated) {
      if (!dryRun) writeFileSync(pluginPath, updated, 'utf-8');
      changes.push(`plugin.json: bumped to ${newVersion}`);
    }
  }

  const marketPath = join(ROOT, '.claude-plugin/marketplace.json');
  if (existsSync(marketPath)) {
    const content = readFileSync(marketPath, 'utf-8');
    const updated = content.replace(/"version":\s*"[^"]*"/g, `"version": "${newVersion}"`);
    if (content !== updated) {
      if (!dryRun) writeFileSync(marketPath, updated, 'utf-8');
      changes.push(`marketplace.json: bumped to ${newVersion}`);
    }
  }

  const claudeMdPath = join(ROOT, 'docs/CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    const updated = content.replace(/<!-- OMC:VERSION:[^\s]*? -->/, `<!-- OMC:VERSION:${newVersion} -->`);
    if (content !== updated) {
      if (!dryRun) writeFileSync(claudeMdPath, updated, 'utf-8');
      changes.push(`docs/CLAUDE.md: version marker → ${newVersion}`);
    }
  }

  if (!dryRun) {
    try {
      execSync('npm install --package-lock-only --ignore-scripts 2>/dev/null', { cwd: ROOT });
      changes.push('package-lock.json: regenerated');
    } catch {
      changes.push('package-lock.json: FAILED to regenerate');
    }
  } else {
    changes.push('package-lock.json: would regenerate');
  }

  return changes;
}

function buildFallbackPullRequests(prNumbers: string[], subjects: string[]): ReleasePullRequest[] {
  return prNumbers.map(number => {
    const subject = subjects.find(entry => entry.includes(`(#${number})`));
    const mergeSubject = subjects.find(entry => entry.startsWith(`Merge pull request #${number} `));
    const headRefMatch = mergeSubject?.match(/from\s+[^/]+\/(.+)$/);

    return {
      number,
      title: subject ? subject.replace(/\s*\(#\d+\)$/, '').trim() : `PR #${number}`,
      author: null,
      headRefName: headRefMatch?.[1] ?? null,
    } satisfies ReleasePullRequest;
  });
}

function isMainModule(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === __filename : false;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const help = args.includes('--help') || args.includes('-h');
  const bumpArg = args.find(a => !a.startsWith('-'));

  if (help || !bumpArg) {
    console.log(`
${clr('Release Automation', c.bold)}

${clr('Usage:', c.cyan)}
  npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]

${clr('Examples:', c.cyan)}
  npm run release -- patch              # 4.8.1 → 4.8.2
  npm run release -- minor              # 4.8.1 → 4.9.0
  npm run release -- 5.0.0              # Set explicit version
  npm run release -- patch --dry-run    # Preview without writing

${clr('What it does:', c.cyan)}
  1. Bumps version in all 5 files (package.json, plugin.json, marketplace.json, docs/CLAUDE.md, lockfile)
  2. Generates CHANGELOG.md from the merged PR set when metadata is available
  3. Generates .github/release-body.md with contributor @mentions
  4. Runs sync-metadata to update doc badges

${clr('After running:', c.cyan)}
  git add -A && git commit -m "chore(release): bump version to vX.Y.Z"
  git push origin dev
  # Wait for CI green, then:
  git checkout main && git merge dev && git push origin main
  git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
  # release.yml handles npm publish + GitHub release
`);
    return;
  }

  const currentVersion = getCurrentVersion();
  const newVersion = bumpVersion(currentVersion, bumpArg);
  const prevTag = getLatestTag();

  console.log(clr('\n🚀 Release Automation', c.bold));
  console.log(clr('═══════════════════════\n', c.dim));
  console.log(`  Current version: ${clr(currentVersion, c.yellow)}`);
  console.log(`  New version:     ${clr(newVersion, c.green)}`);
  console.log(`  Previous tag:    ${clr(prevTag || '(none)', c.dim)}`);
  if (dryRun) console.log(clr('\n  DRY RUN — no files will be modified\n', c.yellow));

  const allCommitLines = getCommitLinesSinceTag(prevTag);
  const allSubjects = allCommitLines.map(line => line.split('|').slice(1).join('|'));
  const fallbackCommits = getNonMergeCommitLinesSinceTag(prevTag)
    .map(parseCommit)
    .filter((commit): commit is ParsedCommit => commit !== null);

  const extractedPrNumbers = extractPullRequestNumbers(allSubjects);
  const fetchedPullRequests = await fetchPullRequestMetadata(extractedPrNumbers);
  const pullRequests = fetchedPullRequests.length > 0
    ? fetchedPullRequests
    : buildFallbackPullRequests(extractedPrNumbers, allSubjects);
  const userFacingPullRequests = pullRequests.filter(pr => !isReleasePullRequest(pr));
  const compareCommitAuthors = fetchedPullRequests.length > 0 ? await fetchCompareCommitAuthors(prevTag) : [];
  const contributors = deriveContributorLogins(userFacingPullRequests, compareCommitAuthors);

  const usingPullRequests = fetchedPullRequests.length > 0;
  const releaseEntries = usingPullRequests
    ? buildReleaseNoteEntriesFromPullRequests(userFacingPullRequests)
    : fallbackCommits.map(toReleaseNoteEntryFromCommit);
  const categories = categorizeReleaseNoteEntries(releaseEntries);
  const prCount = userFacingPullRequests.length > 0 ? userFacingPullRequests.length : extractedPrNumbers.length;

  console.log(clr('\n📊 Release Analysis', c.cyan));
  console.log(`  Total commits: ${allCommitLines.length}`);
  console.log(`  Extracted PRs: ${extractedPrNumbers.length}`);
  console.log(`  User-facing PRs: ${prCount}`);
  console.log(`  Metadata source: ${usingPullRequests ? 'GitHub PR metadata' : 'git fallback'}`);
  console.log(`  Contributors: ${contributors.join(', ') || '(none)'}`);

  for (const [cat, entries] of categories) {
    console.log(`  ${cat}: ${entries.length}`);
  }

  console.log(clr('\n📦 Version Bump', c.cyan));
  const versionChanges = bumpVersionFiles(newVersion, dryRun);
  for (const change of versionChanges) {
    console.log(`  ${clr('✓', c.green)} ${change}`);
  }

  console.log(clr('\n📝 Changelog', c.cyan));
  const changelog = generateChangelog(newVersion, categories, prCount);
  if (!dryRun) {
    writeFileSync(join(ROOT, 'CHANGELOG.md'), changelog, 'utf-8');
    console.log(`  ${clr('✓', c.green)} Written to CHANGELOG.md`);
  } else {
    console.log(`  ${clr('→', c.yellow)} Would write CHANGELOG.md`);
    console.log(clr('\n--- CHANGELOG Preview ---\n', c.dim));
    console.log(changelog);
    console.log(clr('--- End Preview ---\n', c.dim));
  }

  console.log(clr('\n📋 Release Body', c.cyan));
  const releaseBody = generateReleaseBody(newVersion, changelog, contributors, prevTag, REPO_URL);
  const releaseBodyPath = join(ROOT, '.github/release-body.md');
  if (!dryRun) {
    writeFileSync(releaseBodyPath, releaseBody, 'utf-8');
    console.log(`  ${clr('✓', c.green)} Written to .github/release-body.md`);
  } else {
    console.log(`  ${clr('→', c.yellow)} Would write .github/release-body.md`);
  }

  console.log(clr('\n🔄 Sync Metadata', c.cyan));
  if (!dryRun) {
    try {
      execSync('npx tsx scripts/sync-metadata.ts', { cwd: ROOT, stdio: 'inherit' });
    } catch {
      console.log(`  ${clr('⚠', c.yellow)} sync-metadata had warnings (non-fatal)`);
    }
  } else {
    console.log(`  ${clr('→', c.yellow)} Would run sync-metadata`);
  }

  console.log(clr('\n✅ Done!', c.green));
  if (!dryRun) {
    console.log(clr('\nNext steps:', c.bold));
    console.log(`  1. ${clr(`git add -A && git commit -m "chore(release): bump version to v${newVersion}"`, c.cyan)}`);
    console.log(`  2. ${clr('git push origin dev', c.cyan)}`);
    console.log('  3. Wait for CI green');
    console.log(`  4. ${clr('git checkout main && git merge dev && git push origin main', c.cyan)}`);
    console.log(`  5. ${clr(`git tag -a v${newVersion} -m "v${newVersion}" && git push origin v${newVersion}`, c.cyan)}`);
    console.log('  6. release.yml handles npm publish + GitHub release automatically');
  }
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(clr(`\n✖ ${message}`, c.red));
    process.exit(1);
  });
}
