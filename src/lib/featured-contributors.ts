import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const FEATURED_CONTRIBUTORS_START_MARKER = '<!-- OMC:FEATURED-CONTRIBUTORS:START -->';
export const FEATURED_CONTRIBUTORS_END_MARKER = '<!-- OMC:FEATURED-CONTRIBUTORS:END -->';
export const FEATURED_CONTRIBUTORS_TITLE = '## Featured by OmC Contributors';
export const FEATURED_CONTRIBUTORS_MIN_STARS = 100;
const DEFAULT_README_PATH = 'README.md';
const DEFAULT_INSERTION_ANCHOR = '## Star History';
const REQUEST_DELAY_MS = 150;

export interface GitHubContributor {
  login: string;
  html_url: string;
  type: string;
  contributions: number;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  fork: boolean;
  archived?: boolean;
  owner: {
    login: string;
    type: string;
  };
}

export interface FeaturedContributor {
  login: string;
  profileUrl: string;
  repoName: string;
  repoFullName: string;
  repoUrl: string;
  stars: number;
}

export interface SyncFeaturedContributorsOptions {
  dryRun?: boolean;
  minStars?: number;
  projectRoot?: string;
  readmePath?: string;
  repoSlug?: string;
}

export interface SyncFeaturedContributorsResult {
  changed: boolean;
  changes: string[];
  entries: FeaturedContributor[];
  readmePath: string;
}

interface CliOptions {
  dryRun: boolean;
  help: boolean;
  minStars?: number;
  repoSlug?: string;
  verify: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

let cachedGitHubToken: string | null | undefined;

function getGitHubToken(): string | null {
  if (cachedGitHubToken !== undefined) {
    return cachedGitHubToken;
  }

  cachedGitHubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

  if (cachedGitHubToken) {
    return cachedGitHubToken;
  }

  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    cachedGitHubToken = token || null;
  } catch {
    cachedGitHubToken = null;
  }

  return cachedGitHubToken;
}

function getGitHubHeaders(): Record<string, string> {
  const token = getGitHubToken();

  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'oh-my-claudecode-featured-contributors-generator',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return match[1] ?? null;
    }
  }

  return null;
}

async function fetchGitHubJson<T>(url: string): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
  });

  if (!response.ok) {
    const details = await response.text();

    if (response.status === 403) {
      throw new Error(
        `GitHub API request failed with 403 for ${url}. ` +
          'Set GITHUB_TOKEN/GH_TOKEN or slow down requests if you hit secondary rate limits. ' +
          `Response: ${details}`
      );
    }

    throw new Error(`GitHub API request failed with ${response.status} for ${url}: ${details}`);
  }

  return {
    data: (await response.json()) as T,
    headers: response.headers,
  };
}

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = url;
  let firstRequest = true;

  while (nextUrl) {
    if (!firstRequest) {
      await sleep(REQUEST_DELAY_MS);
    }
    firstRequest = false;

    const { data, headers } = await fetchGitHubJson<T[]>(nextUrl);
    items.push(...data);
    nextUrl = parseNextLink(headers.get('link'));
  }

  return items;
}

export function extractRepoSlug(repositoryUrl: string): string {
  const match = repositoryUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match?.[1]) {
    throw new Error(`Could not determine GitHub repository slug from: ${repositoryUrl}`);
  }

  return match[1];
}

export function loadRepoSlugFromPackageJson(projectRoot: string): string {
  const packageJsonPath = join(projectRoot, 'package.json');

  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    repository?: { url?: string } | string;
  };

  const repositoryUrl =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;

  if (!repositoryUrl) {
    throw new Error('package.json is missing repository.url');
  }

  return extractRepoSlug(repositoryUrl);
}

export function formatStarCount(stars: number): string {
  if (stars >= 1000) {
    const compact = (stars / 1000).toFixed(stars >= 10000 ? 0 : 1);
    return `${compact.replace(/\.0$/, '')}k`;
  }

  return String(stars);
}

export function sortFeaturedContributors(entries: FeaturedContributor[]): FeaturedContributor[] {
  return [...entries].sort(
    (left, right) => right.stars - left.stars || left.login.localeCompare(right.login)
  );
}

export function pickTopPersonalRepo(login: string, repos: GitHubRepo[]): GitHubRepo | null {
  const eligibleRepos = repos.filter(
    (repo) =>
      !repo.fork &&
      !repo.archived &&
      repo.owner.login === login &&
      repo.owner.type === 'User'
  );

  if (eligibleRepos.length === 0) {
    return null;
  }

  return [...eligibleRepos].sort(
    (left, right) =>
      right.stargazers_count - left.stargazers_count || left.full_name.localeCompare(right.full_name)
  )[0] ?? null;
}

async function fetchAllTimeContributors(repoSlug: string): Promise<GitHubContributor[]> {
  return fetchAllPages<GitHubContributor>(
    `https://api.github.com/repos/${repoSlug}/contributors?per_page=100`
  );
}

async function fetchOwnedRepos(login: string): Promise<GitHubRepo[]> {
  return fetchAllPages<GitHubRepo>(
    `https://api.github.com/users/${login}/repos?type=owner&per_page=100`
  );
}

export async function collectFeaturedContributors(
  repoSlug: string,
  minStars: number = FEATURED_CONTRIBUTORS_MIN_STARS
): Promise<FeaturedContributor[]> {
  const contributors = await fetchAllTimeContributors(repoSlug);
  const seen = new Set<string>();
  const entries: FeaturedContributor[] = [];

  for (const contributor of contributors) {
    if (contributor.type !== 'User' || seen.has(contributor.login)) {
      continue;
    }

    seen.add(contributor.login);

    const repos = await fetchOwnedRepos(contributor.login);
    const topRepo = pickTopPersonalRepo(contributor.login, repos);

    if (!topRepo || topRepo.stargazers_count < minStars) {
      continue;
    }

    entries.push({
      login: contributor.login,
      profileUrl: contributor.html_url,
      repoName: topRepo.name,
      repoFullName: topRepo.full_name,
      repoUrl: topRepo.html_url,
      stars: topRepo.stargazers_count,
    });
  }

  return sortFeaturedContributors(entries);
}

export function renderFeaturedContributorsSection(
  entries: FeaturedContributor[],
  minStars: number = FEATURED_CONTRIBUTORS_MIN_STARS
): string {
  const sortedEntries = sortFeaturedContributors(entries);
  const lines = [
    FEATURED_CONTRIBUTORS_START_MARKER,
    FEATURED_CONTRIBUTORS_TITLE,
    '',
    `Top personal non-fork, non-archived repos from all-time OMC contributors (${minStars}+ GitHub stars).`,
    '',
  ];

  if (sortedEntries.length === 0) {
    lines.push(`_No contributors currently meet the ${minStars}+ star threshold._`);
  } else {
    for (const entry of sortedEntries) {
      lines.push(
        `- [@${entry.login}](${entry.profileUrl}) — [${entry.repoName}](${entry.repoUrl}) (⭐ ${formatStarCount(entry.stars)})`
      );
    }
  }

  lines.push('', FEATURED_CONTRIBUTORS_END_MARKER);

  return `${lines.join('\n')}\n`;
}

export function upsertFeaturedContributorsSection(
  readmeContent: string,
  featuredSection: string,
  anchor: string = DEFAULT_INSERTION_ANCHOR
): string {
  const startIndex = readmeContent.indexOf(FEATURED_CONTRIBUTORS_START_MARKER);
  const endIndex = readmeContent.indexOf(FEATURED_CONTRIBUTORS_END_MARKER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const blockEnd = endIndex + FEATURED_CONTRIBUTORS_END_MARKER.length;
    const trailingContent = readmeContent.slice(blockEnd);

    return trailingContent.length === 0
      ? `${readmeContent.slice(0, startIndex)}${featuredSection}`
      : `${readmeContent.slice(0, startIndex)}${featuredSection}${trailingContent.replace(/^\n+/, '\n')}`;
  }

  const anchorIndex = readmeContent.indexOf(anchor);
  if (anchorIndex !== -1) {
    return `${readmeContent.slice(0, anchorIndex).replace(/\n*$/, '\n\n')}${featuredSection}\n${readmeContent.slice(anchorIndex)}`;
  }

  return `${readmeContent.replace(/\s*$/, '\n\n')}${featuredSection}`;
}

export async function syncFeaturedContributorsReadme(
  options: SyncFeaturedContributorsOptions = {}
): Promise<SyncFeaturedContributorsResult> {
  const projectRoot = options.projectRoot ?? resolve(__dirname, '../..');
  const readmePath = join(projectRoot, options.readmePath ?? DEFAULT_README_PATH);
  const repoSlug = options.repoSlug ?? loadRepoSlugFromPackageJson(projectRoot);
  const minStars = options.minStars ?? FEATURED_CONTRIBUTORS_MIN_STARS;

  if (!existsSync(readmePath)) {
    throw new Error(`README not found at ${readmePath}`);
  }

  const entries = await collectFeaturedContributors(repoSlug, minStars);
  const originalContent = readFileSync(readmePath, 'utf-8');
  const featuredSection = renderFeaturedContributorsSection(entries, minStars);
  const updatedContent = upsertFeaturedContributorsSection(originalContent, featuredSection);
  const changed = updatedContent !== originalContent;

  if (changed && !options.dryRun) {
    writeFileSync(readmePath, updatedContent, 'utf-8');
  }

  return {
    changed,
    changes: ['Featured contributors README block'],
    entries,
    readmePath,
  };
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    help: false,
    verify: false,
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--verify') {
      options.verify = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg.startsWith('--repo=')) {
      options.repoSlug = arg.slice('--repo='.length);
      continue;
    }

    if (arg.startsWith('--min-stars=')) {
      options.minStars = Number(arg.slice('--min-stars='.length));
      continue;
    }
  }

  return options;
}

export async function runFeaturedContributorsCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);

  if (options.help) {
    console.log(`
Featured Contributors README Generator

Usage:
  npm run sync-featured-contributors
  npm run sync-featured-contributors -- --dry-run
  npm run sync-featured-contributors -- --verify

Options:
  --repo=<owner/name>     Override the GitHub repository slug from package.json
  --min-stars=<number>    Override the minimum star threshold (default: ${FEATURED_CONTRIBUTORS_MIN_STARS})

Notes:
  - Uses GITHUB_TOKEN/GH_TOKEN when set, otherwise falls back to \`gh auth token\` if available.
  - If GitHub returns a rate-limit response, the generator exits without changing README.md.
`);
    return;
  }

  const result = await syncFeaturedContributorsReadme({
    dryRun: options.dryRun || options.verify,
    minStars: options.minStars,
    repoSlug: options.repoSlug,
  });

  if (result.changed) {
    console.log(
      `${options.verify ? '✗' : options.dryRun ? '📝' : '✓'} ${DEFAULT_README_PATH} — featured contributors block`
    );
  } else {
    console.log(`✓ ${DEFAULT_README_PATH} — featured contributors block already up to date`);
  }

  console.log(`Featured contributors: ${result.entries.length}`);

  if (options.verify && result.changed) {
    console.error('Run: npm run sync-featured-contributors');
    process.exit(1);
  }
}
