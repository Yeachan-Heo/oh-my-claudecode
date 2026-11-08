/**
 * Codebase Map Generator
 *
 * Generates a compressed snapshot of the project structure on session start.
 * Injected as context to reduce blind file exploration by 30-50%.
 *
 * Issue #804 - Startup codebase map injection hook
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface CodebaseMapOptions {
  /** Maximum files to include in the map. Default: 200 */
  maxFiles?: number;
  /** Maximum directory depth to scan. Default: 4 */
  maxDepth?: number;
  /** Additional patterns to ignore (matched against entry name) */
  ignorePatterns?: string[];
  /** Whether to include package.json metadata. Default: true */
  includeMetadata?: boolean;
}

export interface CodebaseMapResult {
  /** The formatted codebase map string */
  map: string;
  /** Total source files counted */
  totalFiles: number;
  /** Whether the result was truncated due to maxFiles limit */
  truncated: boolean;
}

// Directories always skipped during scan
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.cache', '.turbo', '.parcel-cache',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'target', '.gradle', 'vendor',
  '.venv', 'venv', 'env',
  '.omc', '.claude',
  'tmp', 'temp',
]);

// File extensions considered source/config files
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp',
  '.cs', '.fs',
  '.vue', '.svelte',
  '.sh', '.bash', '.zsh',
  '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm',
]);

// Lock files and generated manifests — not useful for navigation
const SKIP_FILE_SUFFIXES = ['-lock.json', '.lock', '-lock.yaml', '-lock.toml'];

// Important top-level files always included regardless of extension
const IMPORTANT_FILES = new Set([
  'package.json', 'tsconfig.json', 'tsconfig.base.json',
  'pyproject.toml', 'Cargo.toml', 'go.mod', 'go.sum',
  'CLAUDE.md', 'AGENTS.md', 'README.md', 'CONTRIBUTING.md',
  '.eslintrc.json', 'vitest.config.ts', 'jest.config.ts', 'jest.config.js',
  'Makefile', 'Dockerfile', '.gitignore',
]);

interface TreeNode {
  name: string;
  isDir: boolean;
  children?: TreeNode[];
}

/**
 * Determine whether a directory entry should be skipped.
 */
export function shouldSkipEntry(
  name: string,
  isDir: boolean,
  ignorePatterns: string[],
): boolean {
  // Skip hidden directories (allow hidden files if important)
  if (name.startsWith('.') && isDir && !IMPORTANT_FILES.has(name)) {
    return true;
  }

  // Skip blocked directories
  if (isDir && SKIP_DIRS.has(name)) {
    return true;
  }

  // For files: only include source/config extensions or important files
  if (!isDir) {
    // Skip lock files and generated manifests regardless of extension
    if (SKIP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      return true;
    }
    const ext = extname(name);
    if (!SOURCE_EXTENSIONS.has(ext) && !IMPORTANT_FILES.has(name)) {
      return true;
    }
  }

  // Custom ignore patterns matched against entry name
  for (const pattern of ignorePatterns) {
    if (name.includes(pattern)) return true;
  }

  return false;
}

/**
 * Recursively build a tree structure for the directory.
 */
export function buildTree(
  dir: string,
  depth: number,
  maxDepth: number,
  fileCount: { value: number },
  maxFiles: number,
  ignorePatterns: string[],
): TreeNode[] {
  if (depth > maxDepth || fileCount.value >= maxFiles) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  // Sort: dirs first, then files — both alphabetically
  const withMeta = entries.map((name) => {
    let isDir = false;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      // ignore stat errors
    }
    return { name, isDir };
  });

  withMeta.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: TreeNode[] = [];

  for (const { name, isDir } of withMeta) {
    if (fileCount.value >= maxFiles) break;

    if (shouldSkipEntry(name, isDir, ignorePatterns)) continue;

    if (isDir) {
      const children = buildTree(
        join(dir, name),
        depth + 1,
        maxDepth,
        fileCount,
        maxFiles,
        ignorePatterns,
      );
      nodes.push({ name, isDir: true, children });
    } else {
      fileCount.value++;
      nodes.push({ name, isDir: false });
    }
  }

  return nodes;
}

/**
 * Render a tree of nodes to ASCII art lines.
 */
export function renderTree(nodes: TreeNode[], prefix: string, lines: string[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    lines.push(`${prefix}${connector}${node.name}${node.isDir ? '/' : ''}`);

    if (node.isDir && node.children && node.children.length > 0) {
      renderTree(node.children, prefix + childPrefix, lines);
    }
  }
}

/**
 * Extract a short summary from package.json (name, description, key scripts).
 */
export function extractPackageMetadata(directory: string): string {
  const pkgPath = join(directory, 'package.json');
  if (!existsSync(pkgPath)) return '';

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
    };

    const lines: string[] = [];
    if (pkg.name) lines.push(`Package: ${pkg.name}`);
    if (pkg.description) lines.push(`Description: ${pkg.description}`);
    if (pkg.scripts) {
      const scriptNames = Object.keys(pkg.scripts).slice(0, 8).join(', ');
      if (scriptNames) lines.push(`Scripts: ${scriptNames}`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Generate a compressed codebase map for the given directory.
 *
 * Returns a tree-formatted string of source files with optional project
 * metadata. Designed to be injected at session start to reduce exploratory
 * file-search tool calls by 30-50%.
 */
export function generateCodebaseMap(
  directory: string,
  options: CodebaseMapOptions = {},
): CodebaseMapResult {
  const {
    maxFiles = 200,
    maxDepth = 4,
    ignorePatterns = [],
    includeMetadata = true,
  } = options;

  if (!existsSync(directory)) {
    return { map: '', totalFiles: 0, truncated: false };
  }

  const fileCount = { value: 0 };
  const tree = buildTree(directory, 0, maxDepth, fileCount, maxFiles, ignorePatterns);

  const treeLines: string[] = [];
  renderTree(tree, '', treeLines);
  const treeStr = treeLines.join('\n');

  const parts: string[] = [];

  if (includeMetadata) {
    const meta = extractPackageMetadata(directory);
    if (meta) parts.push(meta);
  }

  parts.push(treeStr);

  const truncated = fileCount.value >= maxFiles;
  if (truncated) {
    parts.push(`[Map truncated at ${maxFiles} files — use Glob/Grep for full search]`);
  }

  return {
    map: parts.join('\n\n'),
    totalFiles: fileCount.value,
    truncated,
  };
}
