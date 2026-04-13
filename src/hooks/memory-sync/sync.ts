/**
 * Memory Sync — Core sync logic
 *
 * Scans Claude project memories, diffs against vault, copies changed files,
 * and commits to the vault git repo.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { MemorySyncConfig, SyncResult, FileChange } from './types.js';

/**
 * Extract a readable project name from Claude's internal path hash.
 *
 * Examples:
 *   -Users-bob-workspace-speakeasy       → speakeasy
 *   -Users-bob-workspace-ai-job-matcher  → ai-job-matcher
 *   -Users-bob-auto-video                → auto-video
 *   -Users-bob                           → global-user
 */
export function extractProjectName(dirName: string): string {
  if (dirName.includes('-workspace-')) {
    return dirName.split('-workspace-').pop()!;
  }
  if (dirName.includes('-Documents-')) {
    return 'obsidian-' + dirName.split('-Documents-').pop()!;
  }
  // Short root path like -Users-bob
  const stripped = dirName.replace(/^-Users-[^-]+-?/, '');
  return stripped || 'global-user';
}

/**
 * Scan Claude project directories and find changed memory files.
 */
function scanChangedFiles(
  claudeDir: string,
  vaultDir: string,
): FileChange[] {
  const changes: FileChange[] = [];
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) return changes;

  for (const entry of fs.readdirSync(projectsDir)) {
    const memoryDir = path.join(projectsDir, entry, 'memory');
    if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
      continue;
    }

    const projectName = extractProjectName(entry);
    const targetMemoryDir = path.join(vaultDir, 'projects', projectName, 'memory');

    // Scan memory/*.md files
    for (const file of fs.readdirSync(memoryDir)) {
      if (!file.endsWith('.md')) continue;

      const source = path.join(memoryDir, file);
      const target = path.join(targetMemoryDir, file);

      if (isFileChanged(source, target)) {
        changes.push({ source, target, project: projectName, type: 'memory' });
      }
    }

    // Check per-project CLAUDE.md
    const projectClaudeMd = path.join(projectsDir, entry, 'CLAUDE.md');
    if (fs.existsSync(projectClaudeMd)) {
      const target = path.join(vaultDir, 'projects', projectName, 'CLAUDE.md');
      if (isFileChanged(projectClaudeMd, target)) {
        changes.push({
          source: projectClaudeMd,
          target,
          project: projectName,
          type: 'claude-md',
        });
      }
    }
  }

  // Global CLAUDE.md
  const globalClaudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(globalClaudeMd)) {
    const target = path.join(vaultDir, 'global', 'CLAUDE.md');
    if (isFileChanged(globalClaudeMd, target)) {
      changes.push({
        source: globalClaudeMd,
        target,
        project: 'global',
        type: 'claude-md',
      });
    }
  }

  return changes;
}

/**
 * Compare source and target files by content.
 * Returns true if they differ or target doesn't exist.
 */
function isFileChanged(source: string, target: string): boolean {
  if (!fs.existsSync(target)) return true;

  try {
    const sourceContent = fs.readFileSync(source, 'utf-8');
    const targetContent = fs.readFileSync(target, 'utf-8');
    return sourceContent !== targetContent;
  } catch {
    return true;
  }
}

/**
 * Copy changed files to vault.
 */
function copyFiles(changes: FileChange[]): number {
  let copied = 0;
  for (const change of changes) {
    const targetDir = path.dirname(change.target);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(change.source, change.target);
    copied++;
  }
  return copied;
}

/**
 * Check if vault path is a git repo.
 */
function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit changes in the vault.
 */
function commitChanges(vaultDir: string, filesChanged: number): boolean {
  try {
    execSync('git add -A', {
      cwd: vaultDir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Check if there's actually something to commit
    execSync('git diff --cached --quiet', {
      cwd: vaultDir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // If git diff --cached --quiet succeeds (exit 0), nothing staged
    return false;
  } catch {
    // git diff --cached --quiet exits 1 when there ARE changes — commit them
    try {
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
      execSync(
        `git commit -m "sync: ${filesChanged} files updated (${timestamp})"`,
        {
          cwd: vaultDir,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Push vault to remote.
 */
function pushToRemote(vaultDir: string): boolean {
  try {
    execSync('git push', {
      cwd: vaultDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Main sync function — called from the SessionEnd hook.
 */
export function syncMemory(config: MemorySyncConfig): SyncResult {
  const claudeDir = path.join(process.env.HOME || '', '.claude');
  const vaultDir = config.vaultPath;

  // Validate
  if (!config.enabled) {
    return { synced: false, filesChanged: 0, committed: false, pushed: false };
  }

  if (!vaultDir || !fs.existsSync(vaultDir)) {
    return {
      synced: false,
      filesChanged: 0,
      committed: false,
      pushed: false,
      error: `Vault path does not exist: ${vaultDir}`,
    };
  }

  if (!isGitRepo(vaultDir)) {
    return {
      synced: false,
      filesChanged: 0,
      committed: false,
      pushed: false,
      error: `Vault path is not a git repository: ${vaultDir}`,
    };
  }

  // Scan and copy
  const changes = scanChangedFiles(claudeDir, vaultDir);
  if (changes.length === 0) {
    return { synced: true, filesChanged: 0, committed: false, pushed: false };
  }

  const copied = copyFiles(changes);

  // Commit
  const committed = commitChanges(vaultDir, copied);

  // Push (optional)
  let pushed = false;
  if (committed && config.autoPush) {
    pushed = pushToRemote(vaultDir);
  }

  return {
    synced: true,
    filesChanged: copied,
    committed,
    pushed,
  };
}
