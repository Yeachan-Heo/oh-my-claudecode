/**
 * Teleport Command - Quick worktree creation for development
 *
 * Creates a git worktree for working on issues/PRs/features in isolation.
 * Default worktree location: ~/Workspace/omc-worktrees/
 */

import chalk from 'chalk';
import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename, isAbsolute, relative } from 'path';
import { parseRemoteUrl, getProvider } from '../../providers/index.js';
import type { ProviderName, GitProvider } from '../../providers/types.js';

export interface TeleportOptions {
  worktree?: boolean;
  worktreePath?: string;
  base?: string;
  noCd?: boolean;
  json?: boolean;
}

export interface TeleportResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

// Default worktree root directory
const DEFAULT_WORKTREE_ROOT = join(homedir(), 'Workspace', 'omc-worktrees');

/**
 * Parse a reference string into components
 * Supports: omc#123, owner/repo#123, #123, URLs, feature names
 */
function parseRef(ref: string): {
  type: 'issue' | 'pr' | 'feature';
  owner?: string;
  repo?: string;
  number?: number;
  name?: string;
  provider?: ProviderName;
} {
  // GitHub PR URL: github.com/owner/repo/pull/N
  const ghPrUrlMatch = ref.match(/^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[?#].*)?$/);
  if (ghPrUrlMatch) {
    return {
      type: 'pr',
      owner: ghPrUrlMatch[1],
      repo: ghPrUrlMatch[2],
      number: parseInt(ghPrUrlMatch[3], 10),
      provider: 'github',
    };
  }

  // GitHub Issue URL: github.com/owner/repo/issues/N
  const ghIssueUrlMatch = ref.match(/^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[?#].*)?$/);
  if (ghIssueUrlMatch) {
    return {
      type: 'issue',
      owner: ghIssueUrlMatch[1],
      repo: ghIssueUrlMatch[2],
      number: parseInt(ghIssueUrlMatch[3], 10),
      provider: 'github',
    };
  }

  // GitLab MR URL: gitlab.*/namespace/-/merge_requests/N (supports nested groups and self-hosted)
  const glMrUrlMatch = ref.match(/^https?:\/\/[^/]*gitlab[^/]*\/(.+)\/-\/merge_requests\/(\d+)(?:[?#].*)?$/);
  if (glMrUrlMatch) {
    const namespaceParts = glMrUrlMatch[1].split('/');
    const repo = namespaceParts.pop()!;
    const owner = namespaceParts.join('/');
    return {
      type: 'pr',
      owner,
      repo,
      number: parseInt(glMrUrlMatch[2], 10),
      provider: 'gitlab',
    };
  }

  // GitLab Issue URL: gitlab.*/namespace/-/issues/N (supports nested groups and self-hosted)
  const glIssueUrlMatch = ref.match(/^https?:\/\/[^/]*gitlab[^/]*\/(.+)\/-\/issues\/(\d+)(?:[?#].*)?$/);
  if (glIssueUrlMatch) {
    const namespaceParts = glIssueUrlMatch[1].split('/');
    const repo = namespaceParts.pop()!;
    const owner = namespaceParts.join('/');
    return {
      type: 'issue',
      owner,
      repo,
      number: parseInt(glIssueUrlMatch[2], 10),
      provider: 'gitlab',
    };
  }

  // Bitbucket PR URL: bitbucket.org/workspace/repo/pull-requests/N
  const bbPrUrlMatch = ref.match(/^https?:\/\/[^/]*bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:[?#].*)?$/);
  if (bbPrUrlMatch) {
    return {
      type: 'pr',
      owner: bbPrUrlMatch[1],
      repo: bbPrUrlMatch[2],
      number: parseInt(bbPrUrlMatch[3], 10),
      provider: 'bitbucket',
    };
  }

  // Bitbucket Issue URL: bitbucket.org/workspace/repo/issues/N
  const bbIssueUrlMatch = ref.match(/^https?:\/\/[^/]*bitbucket\.org\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[?#].*)?$/);
  if (bbIssueUrlMatch) {
    return {
      type: 'issue',
      owner: bbIssueUrlMatch[1],
      repo: bbIssueUrlMatch[2],
      number: parseInt(bbIssueUrlMatch[3], 10),
      provider: 'bitbucket',
    };
  }

  // Azure DevOps PR URL: dev.azure.com/org/project/_git/repo/pullrequest/N
  const azPrUrlMatch = ref.match(/^https?:\/\/[^/]*dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:[?#].*)?$/);
  if (azPrUrlMatch) {
    return {
      type: 'pr',
      owner: `${azPrUrlMatch[1]}/${azPrUrlMatch[2]}`,
      repo: azPrUrlMatch[3],
      number: parseInt(azPrUrlMatch[4], 10),
      provider: 'azure-devops',
    };
  }

  // Azure DevOps legacy: https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
  const azureLegacyPrMatch = ref.match(
    /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i
  );
  if (azureLegacyPrMatch) {
    return {
      type: 'pr',
      provider: 'azure-devops',
      owner: `${azureLegacyPrMatch[1]}/${azureLegacyPrMatch[2]}`,
      repo: azureLegacyPrMatch[3],
      number: parseInt(azureLegacyPrMatch[4], 10),
    };
  }

  // owner/repo!123 format (GitLab MR shorthand, supports nested groups)
  const gitlabShorthand = ref.match(/^(.+?)\/([^!/]+)!(\d+)$/);
  if (gitlabShorthand) {
    return {
      type: 'pr',
      owner: gitlabShorthand[1],
      repo: gitlabShorthand[2],
      number: parseInt(gitlabShorthand[3], 10),
      provider: 'gitlab',
    };
  }

  // owner/repo#123 format (provider-agnostic, supports nested groups)
  const fullRefMatch = ref.match(/^(.+)\/([^/#]+)#(\d+)$/);
  if (fullRefMatch) {
    return {
      type: 'issue', // Will be refined by provider CLI
      owner: fullRefMatch[1],
      repo: fullRefMatch[2],
      number: parseInt(fullRefMatch[3], 10),
    };
  }

  // alias#123 format (e.g., omc#123)
  const aliasMatch = ref.match(/^([a-zA-Z][a-zA-Z0-9_-]*)#(\d+)$/);
  if (aliasMatch) {
    return {
      type: 'issue',
      name: aliasMatch[1], // Alias to resolve
      number: parseInt(aliasMatch[2], 10),
    };
  }

  // #123 format (current repo)
  const numberMatch = ref.match(/^#?(\d+)$/);
  if (numberMatch) {
    return {
      type: 'issue',
      number: parseInt(numberMatch[1], 10),
    };
  }

  // Feature name (anything else)
  return {
    type: 'feature',
    name: ref,
  };
}

/**
 * Sanitize a string for use in branch/directory names
 */
function sanitize(str: string, maxLen: number = 30): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/**
 * Get current git repo info
 */
function getCurrentRepo(): { owner: string; repo: string; root: string; provider: ProviderName } | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    const parsed = parseRemoteUrl(remoteUrl);
    if (parsed) {
      return { owner: parsed.owner, repo: parsed.repo, root, provider: parsed.provider };
    }
  } catch {
    // Not in a git repo or no origin
  }
  return null;
}

/**
 * Fetch issue/PR info via provider abstraction
 */
function fetchProviderInfo(
  type: 'issue' | 'pr',
  number: number,
  provider: GitProvider,
  owner?: string,
  repo?: string
): { title: string; branch?: string } | null {
  if (type === 'pr') {
    const pr = provider.viewPR(number, owner, repo);
    return pr ? { title: pr.title, branch: pr.headBranch } : null;
  }
  const issue = provider.viewIssue(number, owner, repo);
  return issue ? { title: issue.title } : null;
}

/**
 * Create a git worktree
 */
function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string
): { success: boolean; error?: string } {
  try {
    // Ensure worktree parent directory exists
    const parentDir = join(worktreePath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Check if worktree already exists
    if (existsSync(worktreePath)) {
      return { success: false, error: `Worktree already exists at ${worktreePath}` };
    }

    // Fetch latest from origin
    execFileSync('git', ['fetch', 'origin', baseBranch], {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    // Create branch from base if it doesn't exist
    try {
      execFileSync('git', ['branch', branchName, `origin/${baseBranch}`], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch {
      // Branch might already exist, that's OK
    }

    // Create the worktree
    execFileSync('git', ['worktree', 'add', worktreePath, branchName], {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Main teleport command
 */
export async function teleportCommand(
  ref: string,
  options: TeleportOptions
): Promise<TeleportResult> {
  const parsed = parseRef(ref);
  const baseBranch = options.base || 'main';
  const worktreeRoot = options.worktreePath || DEFAULT_WORKTREE_ROOT;

  // Get current repo info
  const currentRepo = getCurrentRepo();
  if (!currentRepo) {
    const error = 'Not in a git repository. Run this command from within a git repo.';
    if (!options.json) {
      console.error(chalk.red(error));
    }
    return { success: false, error };
  }

  const { owner, repo, root: repoRoot } = currentRepo;
  const repoName = basename(repoRoot);
  // Use provider from parsed ref if available, otherwise fall back to current repo
  const effectiveProviderName = parsed.provider || currentRepo.provider;
  const provider = getProvider(effectiveProviderName);

  let branchName: string;
  let worktreeDirName: string;
  let title: string | undefined;

  if (parsed.type === 'feature') {
    // Feature branch
    const safeName = sanitize(parsed.name || 'feature');
    branchName = `feat/${safeName}`;
    worktreeDirName = `feat/${repoName}-${safeName}`;
    title = parsed.name;

    if (!options.json) {
      console.log(chalk.blue(`Creating feature worktree: ${parsed.name}`));
    }
  } else {
    // Issue or PR
    const resolvedOwner = parsed.owner || owner;
    const resolvedRepo = parsed.repo || repo;

    if (!parsed.number) {
      const error = 'Could not parse issue/PR number from reference';
      if (!options.json) {
        console.error(chalk.red(error));
      }
      return { success: false, error };
    }

    if (!provider) {
      const error = `Could not fetch info for #${parsed.number}. Could not detect git provider.`;
      if (!options.json) {
        console.error(chalk.red(error));
      }
      return { success: false, error };
    }

    // Try to detect if it's a PR or issue
    const prInfo = fetchProviderInfo('pr', parsed.number, provider, resolvedOwner, resolvedRepo);
    const issueInfo = !prInfo
      ? fetchProviderInfo('issue', parsed.number, provider, resolvedOwner, resolvedRepo)
      : null;

    const info = prInfo || issueInfo;
    const isPR = !!prInfo;

    if (!info) {
      const cli = provider.getRequiredCLI();
      const error = `Could not fetch info for #${parsed.number} from ${provider.displayName}. ${cli ? `Make sure ${cli} CLI is installed and authenticated.` : 'Check your authentication credentials and network connection.'}`;
      if (!options.json) {
        console.error(chalk.red(error));
      }
      return { success: false, error };
    }

    title = info.title;
    const slug = sanitize(title, 20);

    if (isPR) {
      // For PRs, use the PR's branch
      branchName = info.branch || `pr-${parsed.number}-review`;
      worktreeDirName = `pr/${repoName}-${parsed.number}`;

      if (!options.json) {
        console.log(chalk.blue(`Creating PR review worktree: #${parsed.number} - ${title}`));
      }

      // Fetch the PR branch using provider-specific refspec or head branch
      if (provider.prRefspec) {
        try {
          const refspec = provider.prRefspec
            .replace('{number}', String(parsed.number))
            .replace('{branch}', branchName);
          execFileSync(
            'git', ['fetch', 'origin', refspec],
            { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
          );
        } catch {
          // Branch might already exist
        }
      } else if (info.branch) {
        // For providers without prRefspec (Bitbucket, Azure, Gitea),
        // fetch the PR's head branch from origin
        try {
          execFileSync(
            'git', ['fetch', 'origin', `${info.branch}:${branchName}`],
            { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
          );
        } catch {
          // Branch might already exist locally
        }
      }
    } else {
      // For issues, create a fix branch
      branchName = `fix/${parsed.number}-${slug}`;
      worktreeDirName = `issue/${repoName}-${parsed.number}`;

      if (!options.json) {
        console.log(chalk.blue(`Creating issue fix worktree: #${parsed.number} - ${title}`));
      }
    }
  }

  // Determine full worktree path
  const worktreePath = join(worktreeRoot, worktreeDirName);

  if (!options.json) {
    console.log(chalk.gray(`  Branch: ${branchName}`));
    console.log(chalk.gray(`  Path: ${worktreePath}`));
  }

  // Create the worktree
  const result = createWorktree(repoRoot, worktreePath, branchName, baseBranch);

  if (!result.success) {
    if (!options.json) {
      console.error(chalk.red(`Failed to create worktree: ${result.error}`));
    }
    return { success: false, error: result.error };
  }

  if (!options.json) {
    console.log('');
    console.log(chalk.green('Worktree created successfully!'));
    console.log('');
    console.log(chalk.bold('To start working:'));
    console.log(chalk.cyan(`  cd ${worktreePath}`));
    console.log('');
    if (title) {
      console.log(chalk.gray(`Title: ${title}`));
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      worktreePath,
      branch: branchName,
      title,
    }, null, 2));
  }

  return {
    success: true,
    worktreePath,
    branch: branchName,
  };
}

/**
 * Find worktree directories by scanning for .git files (not directories)
 */
function findWorktreeDirs(dir: string, maxDepth: number = 3, currentDepth: number = 0): string[] {
  if (currentDepth >= maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);
      try {
        const gitPath = join(fullPath, '.git');
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          results.push(fullPath);
          continue; // Don't recurse into worktrees
        }
      } catch {
        // No .git file, recurse deeper
      }
      results.push(...findWorktreeDirs(fullPath, maxDepth, currentDepth + 1));
    }
  } catch {
    // Directory not readable
  }
  return results;
}

/**
 * List existing worktrees in the default location
 */
export async function teleportListCommand(options: { json?: boolean }): Promise<void> {
  const worktreeRoot = DEFAULT_WORKTREE_ROOT;

  if (!existsSync(worktreeRoot)) {
    if (options.json) {
      console.log(JSON.stringify({ worktrees: [] }));
    } else {
      console.log(chalk.gray('No worktrees found.'));
    }
    return;
  }

  const worktreeDirs = findWorktreeDirs(worktreeRoot);

  const worktrees = worktreeDirs.map(worktreePath => {
    const relativePath = relative(worktreeRoot, worktreePath);

    let branch = 'unknown';
    try {
      branch = execSync('git branch --show-current', {
        cwd: worktreePath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Ignore
    }

    return { path: worktreePath, relativePath, branch };
  });

  if (options.json) {
    console.log(JSON.stringify({ worktrees }, null, 2));
  } else {
    if (worktrees.length === 0) {
      console.log(chalk.gray('No worktrees found.'));
      return;
    }

    console.log(chalk.bold('\nOMC Worktrees:\n'));
    console.log(chalk.gray('─'.repeat(60)));

    for (const wt of worktrees) {
      console.log(`  ${chalk.cyan(wt.relativePath)}`);
      console.log(`    Branch: ${chalk.yellow(wt.branch)}`);
      console.log(`    Path: ${chalk.gray(wt.path)}`);
      console.log('');
    }
  }
}

/**
 * Remove a worktree
 * Returns 0 on success, 1 on failure.
 */
export async function teleportRemoveCommand(
  pathOrName: string,
  options: { force?: boolean; json?: boolean }
): Promise<number> {
  const worktreeRoot = DEFAULT_WORKTREE_ROOT;

  // Resolve path - could be relative name or full path
  let worktreePath = pathOrName;
  if (!isAbsolute(pathOrName)) {
    worktreePath = join(worktreeRoot, pathOrName);
  }

  if (!existsSync(worktreePath)) {
    const error = `Worktree not found: ${worktreePath}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(chalk.red(error));
    }
    return 1;
  }

  // Safety check: must be under worktree root
  const rel = relative(worktreeRoot, worktreePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    const error = `Refusing to remove worktree outside of ${worktreeRoot}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error }));
    } else {
      console.error(chalk.red(error));
    }
    return 1;
  }

  try {
    // Check for uncommitted changes
    if (!options.force) {
      const status = execSync('git status --porcelain', {
        cwd: worktreePath,
        encoding: 'utf-8',
      });

      if (status.trim()) {
        const error = 'Worktree has uncommitted changes. Use --force to remove anyway.';
        if (options.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          console.error(chalk.red(error));
        }
        return 1;
      }
    }

    // Find the main repo to run git worktree remove
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();

    // The git-dir will be something like /path/to/main/.git/worktrees/name
    // We need to get back to the main repo
    const mainRepoMatch = gitDir.match(/(.+)[/\\]\.git[/\\]worktrees[/\\]/);
    const mainRepo = mainRepoMatch ? mainRepoMatch[1] : null;

    if (mainRepo) {
      const forceFlag = options.force ? '--force' : '';
      execSync(`git worktree remove "${worktreePath}" ${forceFlag}`, {
        cwd: mainRepo,
        stdio: 'pipe',
      });
    } else {
      // Fallback: just remove the directory
      rmSync(worktreePath, { recursive: true, force: true });
    }

    if (options.json) {
      console.log(JSON.stringify({ success: true, removed: worktreePath }));
    } else {
      console.log(chalk.green(`Removed worktree: ${worktreePath}`));
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: message }));
    } else {
      console.error(chalk.red(`Failed to remove worktree: ${message}`));
    }
    return 1;
  }
}
