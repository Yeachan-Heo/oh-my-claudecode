import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';

export type AutoresearchKeepPolicy = 'score_improvement' | 'pass_only';

export interface AutoresearchEvaluatorContract {
  command: string;
  format: 'json';
  keep_policy?: AutoresearchKeepPolicy;
}

export interface ParsedSandboxContract {
  frontmatter: Record<string, unknown>;
  evaluator: AutoresearchEvaluatorContract;
  body: string;
}

export interface AutoresearchEvaluatorResult {
  pass: boolean;
  score?: number;
}

export interface AutoresearchMissionContract {
  missionDir: string;
  repoRoot: string;
  missionFile: string;
  sandboxFile: string;
  missionRelativeDir: string;
  missionContent: string;
  sandboxContent: string;
  sandbox: ParsedSandboxContract;
  missionSlug: string;
}

function contractError(message: string): Error {
  return new Error(message);
}

function readGit(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : err.stderr instanceof Buffer
        ? err.stderr.toString('utf-8').trim()
        : '';
    throw contractError(stderr || 'mission-dir must be inside a git repository.');
  }
}

export function slugifyMissionName(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  if (base) return base;
  // Hash fallback for non-ASCII names (CJK, Hangul, emoji, etc.)
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return 'mission-' + (hash >>> 0).toString(16).padStart(8, '0');
}

function ensurePathInside(parentPath: string, childPath: string): void {
  const rel = relative(parentPath, childPath);
  if (rel === '' || (!rel.startsWith('..') && rel !== '..')) return;
  throw contractError('mission-dir must be inside a git repository.');
}

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw contractError('sandbox.md must start with YAML frontmatter containing evaluator.command and evaluator.format=json.');
  }
  return {
    frontmatter: match[1] || '',
    body: (match[2] || '').trim(),
  };
}

function parseSimpleYamlFrontmatter(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: string | null = null;

  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      result[currentSection] = {};
      continue;
    }

    const nestedMatch = /^([A-Za-z0-9_-]+):\s*(.+)\s*$/.exec(trimmed);
    if (!nestedMatch) {
      throw contractError(`Unsupported sandbox.md frontmatter line: ${trimmed}`);
    }

    const [, key, rawValue] = nestedMatch;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!currentSection) {
        throw contractError(`Nested sandbox.md frontmatter key requires a parent section: ${trimmed}`);
      }
      const section = result[currentSection];
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw contractError(`Invalid sandbox.md frontmatter section: ${currentSection}`);
      }
      (section as Record<string, unknown>)[key] = value;
      continue;
    }

    result[key] = value;
    currentSection = null;
  }

  return result;
}

function parseKeepPolicy(raw: unknown): AutoresearchKeepPolicy | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw contractError('sandbox.md frontmatter evaluator.keep_policy must be a string when provided.');
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'pass_only') return 'pass_only';
  if (normalized === 'score_improvement') return 'score_improvement';
  throw contractError('sandbox.md frontmatter evaluator.keep_policy must be one of: score_improvement, pass_only.');
}

export function parseSandboxContract(content: string): ParsedSandboxContract {
  const { frontmatter, body } = extractFrontmatter(content);
  const parsedFrontmatter = parseSimpleYamlFrontmatter(frontmatter);
  const evaluatorRaw = parsedFrontmatter.evaluator;

  if (!evaluatorRaw || typeof evaluatorRaw !== 'object' || Array.isArray(evaluatorRaw)) {
    throw contractError('sandbox.md frontmatter must define an evaluator block.');
  }

  const evaluator = evaluatorRaw as { command?: unknown; format?: unknown; keep_policy?: unknown };
  const command = typeof evaluator.command === 'string'
    ? evaluator.command.trim()
    : '';
  const format = typeof evaluator.format === 'string'
    ? evaluator.format.trim().toLowerCase()
    : '';
  const keepPolicy = parseKeepPolicy(evaluator.keep_policy);

  if (!command) {
    throw contractError('sandbox.md frontmatter evaluator.command is required.');
  }
  if (!format) {
    throw contractError('sandbox.md frontmatter evaluator.format is required and must be json in autoresearch v1.');
  }
  if (format !== 'json') {
    throw contractError('sandbox.md frontmatter evaluator.format must be json in autoresearch v1.');
  }

  return {
    frontmatter: parsedFrontmatter,
    evaluator: {
      command,
      format: 'json',
      ...(keepPolicy ? { keep_policy: keepPolicy } : {}),
    },
    body,
  };
}

export function parseEvaluatorResult(raw: string): AutoresearchEvaluatorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw contractError('Evaluator output must be valid JSON with required boolean pass and optional numeric score.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw contractError('Evaluator output must be a JSON object.');
  }

  const result = parsed as Record<string, unknown>;
  if (typeof result.pass !== 'boolean') {
    throw contractError('Evaluator output must include boolean pass.');
  }
  if (result.score !== undefined && typeof result.score !== 'number') {
    throw contractError('Evaluator output score must be numeric when provided.');
  }

  return result.score === undefined
    ? { pass: result.pass }
    : { pass: result.pass, score: result.score };
}

export async function loadAutoresearchMissionContract(missionDirArg: string): Promise<AutoresearchMissionContract> {
  const missionDir = resolve(missionDirArg);
  if (!existsSync(missionDir)) {
    throw contractError(`mission-dir does not exist: ${missionDir}`);
  }

  const repoRoot = readGit(missionDir, ['rev-parse', '--show-toplevel']);
  ensurePathInside(repoRoot, missionDir);

  const missionFile = join(missionDir, 'mission.md');
  const sandboxFile = join(missionDir, 'sandbox.md');
  if (!existsSync(missionFile)) {
    throw contractError(`mission.md is required inside mission-dir: ${missionFile}`);
  }
  if (!existsSync(sandboxFile)) {
    throw contractError(`sandbox.md is required inside mission-dir: ${sandboxFile}`);
  }

  const missionContent = await readFile(missionFile, 'utf-8');
  const sandboxContent = await readFile(sandboxFile, 'utf-8');
  const sandbox = parseSandboxContract(sandboxContent);
  const missionRelativeDir = relative(repoRoot, missionDir) || basename(missionDir);
  const missionSlug = slugifyMissionName(missionRelativeDir);

  return {
    missionDir,
    repoRoot,
    missionFile,
    sandboxFile,
    missionRelativeDir,
    missionContent,
    sandboxContent,
    sandbox,
    missionSlug,
  };
}
