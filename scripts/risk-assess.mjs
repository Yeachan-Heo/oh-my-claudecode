#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical', 'unknown'];

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh']);
const CONFIG_FILENAMES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'tsconfig.json', 'eslint.config.js', 'vite.config.ts', 'vitest.config.ts', 'webpack.config.js', 'rollup.config.js', 'dockerfile', 'docker-compose.yml']);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini']);
const HIGH_RISK_SEGMENTS = new Set(['auth', 'authentication', 'authorization', 'oauth', 'password', 'secret', 'secrets', 'credential', 'credentials', 'token', 'tokens', 'session', 'sessions', 'permission', 'permissions', 'migration', 'migrations', 'schema', 'schemas', 'database', 'db', 'security', 'crypto', 'encryption']);
const HIGH_RISK_FILENAMES = new Set(['schema.prisma']);

function normalizeFile(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isNoisePath(file) {
  const normalized = normalizeFile(file).toLowerCase();
  if (!normalized) return true;
  const base = path.posix.basename(normalized);
  if (base.endsWith('.log')) return true;
  if (base === 'harness-state.json' || base.endsWith('.snapshot.json') || base.endsWith('.snap.json')) return true;
  return normalized.startsWith('.omc/harness-state/') ||
    normalized === '.omc/harness-state' ||
    normalized.startsWith('.omc/state/') ||
    normalized.startsWith('.omx/state/') ||
    normalized.startsWith('logs/');
}

function pathSegments(file) {
  return normalizeFile(file).split('/').filter(Boolean);
}

function hasHighRiskToken(segment) {
  const ext = path.posix.extname(segment);
  const stem = ext ? segment.slice(0, -ext.length) : segment;
  const camelSpaced = stem
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  const lowerSegment = segment.toLowerCase();
  const lowerStem = camelSpaced.toLowerCase();
  if (HIGH_RISK_SEGMENTS.has(lowerSegment) || HIGH_RISK_SEGMENTS.has(lowerStem)) return true;
  return lowerStem.split(/[^a-z0-9]+/u).some(token => HIGH_RISK_SEGMENTS.has(token));
}

export function hasHighRiskPath(file) {
  const normalized = normalizeFile(file);
  if (isDocsPath(normalized)) return false;
  const base = path.posix.basename(normalized).toLowerCase();
  if (HIGH_RISK_FILENAMES.has(base)) return true;
  return pathSegments(normalized).some(segment => hasHighRiskToken(segment));
}

function isDocsPath(file) {
  const normalized = normalizeFile(file).toLowerCase();
  const ext = path.posix.extname(normalized);
  return normalized.startsWith('docs/') || normalized.includes('/docs/') || DOC_EXTENSIONS.has(ext) || normalized.startsWith('readme');
}

function isCodePath(file) {
  return CODE_EXTENSIONS.has(path.posix.extname(normalizeFile(file).toLowerCase()));
}

function isConfigPath(file) {
  const normalized = normalizeFile(file).toLowerCase();
  const base = path.posix.basename(normalized);
  return CONFIG_FILENAMES.has(base) ||
    CONFIG_EXTENSIONS.has(path.posix.extname(normalized)) ||
    base === '.env' ||
    base.startsWith('.env.') ||
    normalized.startsWith('.github/workflows/');
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseNameStatus(output) {
  const files = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('R') || status.startsWith('C')) {
      if (parts[1]) files.push(parts[1]);
      if (parts[2]) files.push(parts[2]);
    } else if (parts[1]) {
      files.push(parts[1]);
    }
  }
  return files;
}

function unique(files) {
  return [...new Set(files.map(normalizeFile).filter(Boolean))];
}

function getChangedFiles(cwd, { stagedOnly = false } = {}) {
  if (stagedOnly) {
    return unique(parseNameStatus(runGit(cwd, ['diff', '--cached', '--name-status'])));
  }
  return unique([
    ...parseNameStatus(runGit(cwd, ['diff', '--cached', '--name-status'])),
    ...parseNameStatus(runGit(cwd, ['diff', '--name-status'])),
  ]);
}

function numstatPathCandidates(file) {
  const normalized = normalizeFile(file);
  const braceRename = normalized.match(/^(.*)\{(.+) => (.+)\}(.*)$/u);
  if (braceRename) {
    const [, prefix, oldPart, newPart, suffix] = braceRename;
    return [normalizeFile(`${prefix}${oldPart}${suffix}`), normalizeFile(`${prefix}${newPart}${suffix}`)];
  }
  const arrowRename = normalized.match(/^(.+) => (.+)$/u);
  if (arrowRename) {
    return [normalizeFile(arrowRename[1]), normalizeFile(arrowRename[2])];
  }
  return [normalized];
}

function countNumstatLines(output, relevant) {
  let lines = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [insertions, deletions, maybePath, renamePath] = line.split('\t');
    const candidates = numstatPathCandidates(renamePath || maybePath || '');
    if (!candidates.some(file => relevant.has(file) && !isNoisePath(file))) continue;
    const add = Number.parseInt(insertions, 10);
    const del = Number.parseInt(deletions, 10);
    lines += (Number.isFinite(add) ? add : 0) + (Number.isFinite(del) ? del : 0);
  }
  return lines;
}

function getWeightedDiffSize(cwd, changedFiles, { stagedOnly = false } = {}) {
  const relevant = new Set(changedFiles.filter(file => !isNoisePath(file)));
  if (stagedOnly) {
    return countNumstatLines(runGit(cwd, ['diff', '--numstat', '--cached']), relevant);
  }
  return countNumstatLines(runGit(cwd, ['diff', '--numstat', '--cached']), relevant) +
    countNumstatLines(runGit(cwd, ['diff', '--numstat']), relevant);
}

export function classifyChangedFiles(changedFiles, diffSize = 0) {
  const relevantFiles = unique(changedFiles).filter(file => !isNoisePath(file));
  if (relevantFiles.length === 0) {
    return { level: 'none', reason: 'No relevant changed files after ignoring review-gate noise paths', relevantFiles };
  }

  const docsOnly = relevantFiles.every(isDocsPath);
  const hasCode = relevantFiles.some(isCodePath);
  const hasConfig = relevantFiles.some(isConfigPath);
  const hasHighRisk = relevantFiles.some(file => hasHighRiskPath(file) && !isDocsPath(file));

  if (hasHighRisk) {
    return { level: 'critical', reason: 'Sensitive source/config path segment changed', relevantFiles };
  }
  if (docsOnly) {
    return { level: 'low', reason: 'Documentation-only changes', relevantFiles };
  }
  if (hasCode && diffSize > 100) {
    return { level: 'high', reason: `Code changes exceed 100 relevant diff lines (${diffSize})`, relevantFiles };
  }
  if (hasCode) {
    return { level: diffSize <= 20 ? 'low' : 'medium', reason: `Code changes with ${diffSize} relevant diff lines`, relevantFiles };
  }
  if (hasConfig) {
    return { level: 'medium', reason: 'Configuration/build metadata changes', relevantFiles };
  }
  return { level: diffSize <= 20 ? 'low' : 'medium', reason: `Mixed non-code changes with ${diffSize} relevant diff lines`, relevantFiles };
}

export function assessRisk(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stagedOnly = Boolean(options.stagedOnly || options.context === 'commit');
  try {
    const changedFiles = getChangedFiles(cwd, { stagedOnly });
    const relevantFiles = changedFiles.filter(file => !isNoisePath(file));
    const diffSize = getWeightedDiffSize(cwd, changedFiles, { stagedOnly });
    const classification = classifyChangedFiles(changedFiles, diffSize);
    return {
      level: classification.level,
      reason: classification.reason,
      changedFiles,
      relevantFiles,
      diffSize,
      stagedOnly,
    };
  } catch (error) {
    return {
      level: 'unknown',
      reason: `Unable to assess git diff: ${error instanceof Error ? error.message : String(error)}`,
      changedFiles: [],
      relevantFiles: [],
      diffSize: 0,
      stagedOnly,
    };
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit' || arg === '--staged' || arg === '--staged-only') options.stagedOnly = true;
    else if (arg === '--context') options.context = argv[++index];
    else if (arg === '--cwd') options.cwd = argv[++index];
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = assessRisk(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.level === 'unknown' ? 2 : 0);
}
