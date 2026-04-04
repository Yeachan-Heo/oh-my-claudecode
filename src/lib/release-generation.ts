const DEFAULT_REPO_URL = 'https://github.com/Yeachan-Heo/oh-my-claudecode';

export interface ReleasePullRequest {
  number: string;
  title: string;
  author: string | null;
  headRefName: string | null;
}

export interface ReleaseNoteEntry {
  type: string;
  scope: string;
  description: string;
  prNumber: string | null;
}

interface ChangelogSection {
  title: string;
  entries: string[];
}

const CONVENTIONAL_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?:\s*(?<desc>.+)$/;

function parseConventionalSubject(raw: string): { type: string; scope: string; description: string } | null {
  const match = raw.match(CONVENTIONAL_RE);
  if (!match?.groups) return null;

  return {
    type: match.groups.type,
    scope: match.groups.scope || '',
    description: match.groups.desc.replace(/\s*\(#\d+\)$/, '').trim(),
  };
}

export function extractPullRequestNumbers(subjects: string[]): string[] {
  const numbers = new Set<string>();

  for (const subject of subjects) {
    for (const match of subject.matchAll(/#(\d+)/g)) {
      numbers.add(match[1]);
    }
  }

  return [...numbers];
}

export function isReleasePullRequest(pr: Pick<ReleasePullRequest, 'title' | 'headRefName'>): boolean {
  const title = pr.title.trim();
  const headRefName = pr.headRefName?.trim() || '';

  return (
    /^release\s*:/i.test(title) ||
    /^chore\(release\)/i.test(title) ||
    /^release\//i.test(headRefName)
  );
}

export function deriveContributorLogins(
  pullRequests: Array<Pick<ReleasePullRequest, 'author'>>,
  compareCommitAuthors: Array<string | null | undefined>,
): string[] {
  const contributors = new Set<string>();

  for (const author of compareCommitAuthors) {
    if (author) contributors.add(author);
  }

  for (const pr of pullRequests) {
    if (pr.author) contributors.add(pr.author);
  }

  return [...contributors].sort((a, b) => a.localeCompare(b));
}

function toReleaseNoteEntryFromPullRequest(pr: ReleasePullRequest): ReleaseNoteEntry {
  const parsed = parseConventionalSubject(pr.title);
  if (!parsed) {
    return {
      type: 'other',
      scope: '',
      description: pr.title,
      prNumber: pr.number,
    };
  }

  return {
    type: parsed.type,
    scope: parsed.scope,
    description: parsed.description,
    prNumber: pr.number,
  };
}

export function buildReleaseNoteEntriesFromPullRequests(pullRequests: ReleasePullRequest[]): ReleaseNoteEntry[] {
  return pullRequests.map(toReleaseNoteEntryFromPullRequest);
}

export function categorizeReleaseNoteEntries(entries: ReleaseNoteEntry[]): Map<string, ReleaseNoteEntry[]> {
  const categories = new Map<string, ReleaseNoteEntry[]>();

  for (const entry of entries) {
    let category: string;

    if (entry.type === 'feat' || entry.type === 'perf') {
      category = 'features';
    } else if ((entry.type === 'fix' && /^(security|deps)$/.test(entry.scope)) || (entry.type === 'chore' && entry.scope === 'deps')) {
      category = 'security';
    } else if (entry.type === 'fix') {
      category = 'fixes';
    } else if (entry.type === 'refactor') {
      category = 'refactoring';
    } else if (entry.type === 'docs') {
      category = 'docs';
    } else if (entry.type === 'other' || entry.type === 'chore' || entry.type === 'ci' || entry.type === 'build') {
      category = 'other';
    } else {
      continue;
    }

    if (!categories.has(category)) categories.set(category, []);
    categories.get(category)!.push(entry);
  }

  return categories;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatEntry(entry: ReleaseNoteEntry): string {
  const pr = entry.prNumber ? ` (#${entry.prNumber})` : '';

  if (entry.type === 'other') {
    return `- **${entry.description}**${pr}`;
  }

  const scope = entry.scope ? `(${entry.scope})` : '';
  return `- **${entry.type}${scope}: ${entry.description}**${pr}`;
}

function generateTitle(categories: Map<string, ReleaseNoteEntry[]>): string {
  const parts: string[] = [];

  if (categories.has('features')) {
    const keywords = categories.get('features')!
      .slice(0, 3)
      .map(entry => entry.description.split(/\s+/).slice(0, 3).join(' '));
    parts.push(...keywords);
  }
  if (categories.has('security')) parts.push('Security Hardening');
  if (categories.has('fixes') && parts.length === 0) parts.push('Bug Fixes');

  if (parts.length === 0) return 'Maintenance Release';
  if (parts.length <= 3) return parts.join(', ');
  return parts.slice(0, 3).join(', ');
}

function generateSummary(categories: Map<string, ReleaseNoteEntry[]>, prCount: number): string {
  const parts: string[] = [];
  const featureCount = categories.get('features')?.length ?? 0;
  const securityCount = categories.get('security')?.length ?? 0;
  const fixCount = categories.get('fixes')?.length ?? 0;
  const otherCount = categories.get('other')?.length ?? 0;

  if (featureCount > 0) parts.push(`**${pluralize(featureCount, 'new feature')}**`);
  if (securityCount > 0) parts.push(`**${pluralize(securityCount, 'security improvement')}**`);
  if (fixCount > 0) parts.push(`**${pluralize(fixCount, 'bug fix', 'bug fixes')}**`);
  if (otherCount > 0) parts.push(`**${pluralize(otherCount, 'other change')}**`);

  if (parts.length === 0) return 'Maintenance release with internal improvements.';
  return `Release with ${parts.join(', ')} across **${pluralize(prCount, 'merged PR')}**.`;
}

export function generateChangelog(
  version: string,
  categories: Map<string, ReleaseNoteEntry[]>,
  prCount: number,
): string {
  const title = generateTitle(categories);
  const summary = generateSummary(categories, prCount);
  const sections: ChangelogSection[] = [];

  const highlights: string[] = [];
  const highlightSources = [
    ...(categories.get('features') ?? []).slice(0, 5),
    ...(categories.get('security') ?? []).slice(0, 3),
  ];

  if (highlightSources.length === 0) {
    highlightSources.push(...(categories.get('fixes') ?? []).slice(0, 3));
  }

  for (const entry of highlightSources) {
    highlights.push(formatEntry(entry));
  }

  if (highlights.length) sections.push({ title: 'Highlights', entries: highlights });
  if (categories.has('features')) sections.push({ title: 'New Features', entries: categories.get('features')!.map(formatEntry) });
  if (categories.has('security')) sections.push({ title: 'Security & Hardening', entries: categories.get('security')!.map(formatEntry) });
  if (categories.has('fixes')) sections.push({ title: 'Bug Fixes', entries: categories.get('fixes')!.map(formatEntry) });
  if (categories.has('refactoring')) sections.push({ title: 'Refactoring', entries: categories.get('refactoring')!.map(formatEntry) });
  if (categories.has('docs')) sections.push({ title: 'Documentation', entries: categories.get('docs')!.map(formatEntry) });
  if (categories.has('other')) sections.push({ title: 'Other Changes', entries: categories.get('other')!.map(formatEntry) });

  const featCount = categories.get('features')?.length ?? 0;
  const fixCount = categories.get('fixes')?.length ?? 0;
  const secCount = categories.get('security')?.length ?? 0;
  const otherCount = categories.get('other')?.length ?? 0;
  const statsLine = `- **${pluralize(prCount, 'PR merged', 'PRs merged')}** | **${pluralize(featCount, 'new feature')}** | **${pluralize(fixCount, 'bug fix', 'bug fixes')}** | **${pluralize(secCount, 'security/hardening improvement')}** | **${pluralize(otherCount, 'other change')}**`;

  let md = `# oh-my-claudecode v${version}: ${title}\n\n`;
  md += `## Release Notes\n\n${summary}\n`;

  for (const section of sections) {
    md += `\n### ${section.title}\n\n`;
    md += section.entries.join('\n') + '\n';
  }

  md += `\n### Stats\n\n${statsLine}\n`;
  return md;
}

export function generateReleaseBody(
  version: string,
  changelog: string,
  contributors: string[],
  prevTag: string,
  repoUrl: string = DEFAULT_REPO_URL,
): string {
  let body = changelog;

  body += `\n### Install / Update\n\n`;
  body += '```bash\n';
  body += `npm install -g oh-my-claude-sisyphus@${version}\n`;
  body += '```\n\n';
  body += 'Or reinstall the plugin:\n```bash\nclaude /install-plugin oh-my-claudecode\n```\n';

  if (prevTag) {
    body += `\n**Full Changelog**: ${repoUrl}/compare/${prevTag}...v${version}\n`;
  }

  if (contributors.length > 0) {
    body += `\n## Contributors\n\nThank you to all contributors who made this release possible!\n\n`;
    body += contributors.map(login => `@${login}`).join(' ') + '\n';
  }

  return body;
}
