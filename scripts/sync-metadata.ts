#!/usr/bin/env node
/**
 * Metadata Sync System
 *
 * Synchronizes version and metadata from package.json to all documentation files.
 * Prevents version drift and ensures consistency across the project.
 *
 * Usage:
 *   npm run sync-metadata              # Sync all files
 *   npm run sync-metadata -- --dry-run # Preview changes
 *   npm run sync-metadata -- --verify  # Check if files are in sync
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Color utilities for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function color(text: string, colorCode: string): string {
  return `${colorCode}${text}${colors.reset}`;
}

// Metadata interface
interface Metadata {
  version: string;
  description: string;
  keywords: string[];
  repository: string;
  homepage: string;
  npmPackage: string;
}

// File sync configuration
interface FileSync {
  path: string;
  replacements: Array<{
    pattern: RegExp;
    replacement: (metadata: Metadata) => string;
    description: string;
  }>;
}

// Load metadata from package.json
function loadMetadata(): Metadata {
  const projectRoot = resolve(__dirname, '..');
  const packageJsonPath = join(projectRoot, 'package.json');

  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

  return {
    version: packageJson.version,
    description: packageJson.description || '',
    keywords: packageJson.keywords || [],
    repository: packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') || '',
    homepage: packageJson.homepage || '',
    npmPackage: packageJson.name || 'oh-my-claude-sisyphus',
  };
}

// Get count of agents from agents directory
function getAgentCount(): number {
  const projectRoot = resolve(__dirname, '..');
  const agentsDir = join(projectRoot, 'agents');

  if (!existsSync(agentsDir)) {
    return 0;
  }

  const files = readdirSync(agentsDir);
  return files.filter((f: string) => f.endsWith('.md')).length;
}

// Get count of skills from skills directory (directories, not files)
function getSkillCount(): number {
  const projectRoot = resolve(__dirname, '..');
  const skillsDir = join(projectRoot, 'skills');

  if (!existsSync(skillsDir)) {
    return 0;
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

// Define file sync configurations
function getFileSyncConfigs(): FileSync[] {
  const agentCount = getAgentCount();
  const skillCount = getSkillCount();

  return [
    {
      path: 'README.md',
      replacements: [
        {
          pattern: /\[!\[npm version\]\(https:\/\/img\.shields\.io\/npm\/v\/[^)]+\)/g,
          replacement: (m) => `[![npm version](https://img.shields.io/npm/v/${m.npmPackage}?color=cb3837)`,
          description: 'npm version badge',
        },
        {
          pattern: /\[!\[npm downloads\]\(https:\/\/img\.shields\.io\/npm\/dm\/[^)]+\)/g,
          replacement: (m) => `[![npm downloads](https://img.shields.io/npm/dm/${m.npmPackage}?color=blue)`,
          description: 'npm downloads badge',
        },
      ],
    },
    {
      path: 'docs/FULL-README.md',
      replacements: [
        {
          pattern: /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-[^-]+-[^)]+\)/g,
          replacement: (m) => `[![Version](https://img.shields.io/badge/version-${m.version}-ff6b6b)`,
          description: 'Version badge',
        },
        {
          pattern: /\[!\[npm version\]\(https:\/\/img\.shields\.io\/npm\/v\/[^?]+[^)]*\)/g,
          replacement: (m) => `[![npm version](https://img.shields.io/npm/v/${m.npmPackage}?color=cb3837)`,
          description: 'npm version badge',
        },
        {
          pattern: /## NEW in \d+\.\d+\.\d+:/g,
          replacement: (m) => `## NEW in ${m.version}:`,
          description: 'Version header',
        },
        {
          pattern: /## ⚡ NEW in \d+\.\d+:/g,
          replacement: (m) => {
            const [major, minor] = m.version.split('.');
            return `## ⚡ NEW in ${major}.${minor}:`;
          },
          description: 'Major.minor version header',
        },
      ],
    },
    {
      path: '.github/CLAUDE.md',
      replacements: [
        {
          pattern: /\*\*\d+ specialized agents\*\*/g,
          replacement: () => `**${agentCount} specialized agents**`,
          description: 'Agent count',
        },
        {
          pattern: /\*\*\d+ slash commands\*\*/g,
          replacement: () => `**${skillCount} slash commands**`,
          description: 'Slash command count',
        },
      ],
    },
    {
      path: 'docs/ARCHITECTURE.md',
      replacements: [
        {
          pattern: /version \d+\.\d+\.\d+/gi,
          replacement: (m) => `version ${m.version}`,
          description: 'Architecture version references',
        },
      ],
    },
    {
      path: 'CHANGELOG.md',
      replacements: [
        // CHANGELOG is manually maintained, only verify latest version exists
        {
          pattern: /^## \[\d+\.\d+\.\d+\]/m,
          replacement: (m) => `## [${m.version}]`,
          description: 'Latest version header (verify only)',
        },
      ],
    },
  ];
}

// Sync a single file
function syncFile(
  config: FileSync,
  metadata: Metadata,
  dryRun: boolean,
  projectRoot: string
): { changed: boolean; changes: string[] } {
  const filePath = join(projectRoot, config.path);

  if (!existsSync(filePath)) {
    console.log(color(`⚠ File not found: ${config.path}`, colors.yellow));
    return { changed: false, changes: [] };
  }

  let content = readFileSync(filePath, 'utf-8');
  const originalContent = content;
  const changes: string[] = [];

  for (const replacement of config.replacements) {
    const matches = content.match(replacement.pattern);
    if (matches) {
      const newContent = content.replace(
        replacement.pattern,
        replacement.replacement(metadata)
      );

      if (newContent !== content) {
        changes.push(replacement.description);
        content = newContent;
      }
    }
  }

  const changed = content !== originalContent;

  if (changed && !dryRun) {
    writeFileSync(filePath, content, 'utf-8');
  }

  return { changed, changes };
}

// Verify all files are in sync
function verifySync(metadata: Metadata, projectRoot: string): boolean {
  console.log(color('\n🔍 Verifying metadata sync...', colors.cyan));

  const configs = getFileSyncConfigs();
  let allInSync = true;

  for (const config of configs) {
    const result = syncFile(config, metadata, true, projectRoot);

    if (result.changed) {
      allInSync = false;
      console.log(color(`✗ ${config.path}`, colors.red));
      result.changes.forEach(change => {
        console.log(color(`  - ${change} needs update`, colors.yellow));
      });
    } else {
      console.log(color(`✓ ${config.path}`, colors.green));
    }
  }

  return allInSync;
}

// Main sync operation
function syncAll(dryRun: boolean): void {
  const projectRoot = resolve(__dirname, '..');
  const metadata = loadMetadata();

  console.log(color('\n📦 Metadata Sync System', colors.bright));
  console.log(color('========================\n', colors.bright));
  console.log(`Version: ${color(metadata.version, colors.green)}`);
  console.log(`Package: ${color(metadata.npmPackage, colors.cyan)}`);
  console.log(`Agents: ${color(String(getAgentCount()), colors.blue)}`);
  console.log(`Skills: ${color(String(getSkillCount()), colors.blue)}`);

  if (dryRun) {
    console.log(color('\n🔍 DRY RUN MODE - No files will be modified\n', colors.yellow));
  }

  const configs = getFileSyncConfigs();
  let totalChanges = 0;

  for (const config of configs) {
    const result = syncFile(config, metadata, dryRun, projectRoot);

    if (result.changed) {
      totalChanges++;
      const status = dryRun ? '📝' : '✓';
      console.log(color(`\n${status} ${config.path}`, colors.cyan));
      result.changes.forEach(change => {
        console.log(color(`  - ${change}`, colors.blue));
      });
    }
  }

  if (totalChanges === 0) {
    console.log(color('\n✅ All files are already in sync!', colors.green));
  } else if (dryRun) {
    console.log(color(`\n📊 ${totalChanges} file(s) would be updated`, colors.yellow));
    console.log(color('Run without --dry-run to apply changes', colors.cyan));
  } else {
    console.log(color(`\n✅ Successfully synced ${totalChanges} file(s)!`, colors.green));
  }
}

// CLI
function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`
${color('Metadata Sync System', colors.bright)}

${color('Usage:', colors.cyan)}
  npm run sync-metadata              Sync all files
  npm run sync-metadata -- --dry-run Preview changes without writing
  npm run sync-metadata -- --verify  Check if files are in sync

${color('Description:', colors.cyan)}
  Synchronizes version and metadata from package.json to documentation files.
  Prevents version drift and ensures consistency across the project.

${color('Files Synced:', colors.cyan)}
  - README.md (npm badges)
  - docs/FULL-README.md (version badges and headers)
  - .github/CLAUDE.md (agent/skill counts)
  - docs/ARCHITECTURE.md (version references)
  - CHANGELOG.md (version header verification)

${color('Examples:', colors.cyan)}
  npm run sync-metadata              # Apply all updates
  npm run sync-metadata -- --dry-run # See what would change
  npm run sync-metadata -- --verify  # CI/CD verification
`);
    return;
  }

  try {
    if (verify) {
      const projectRoot = resolve(__dirname, '..');
      const metadata = loadMetadata();
      const inSync = verifySync(metadata, projectRoot);

      if (!inSync) {
        console.log(color('\n❌ Files are out of sync!', colors.red));
        console.log(color('Run: npm run sync-metadata', colors.cyan));
        process.exit(1);
      } else {
        console.log(color('\n✅ All files are in sync!', colors.green));
      }
    } else {
      syncAll(dryRun);
    }
  } catch (error) {
    console.error(color('\n❌ Error:', colors.red), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for testing
export { loadMetadata, syncFile, verifySync, getAgentCount, getSkillCount };
