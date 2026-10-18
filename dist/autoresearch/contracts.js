import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';
function contractError(message) {
    return new Error(message);
}
function readGit(repoPath, args) {
    try {
        return execFileSync('git', args, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
    }
    catch (error) {
        const err = error;
        const stderr = typeof err.stderr === 'string'
            ? err.stderr.trim()
            : err.stderr instanceof Buffer
                ? err.stderr.toString('utf-8').trim()
                : '';
        throw contractError(stderr || 'mission-dir must be inside a git repository.');
    }
}
export function slugifyMissionName(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'mission';
}
function ensurePathInside(parentPath, childPath) {
    const rel = relative(parentPath, childPath);
    if (rel === '' || (!rel.startsWith('..') && rel !== '..'))
        return;
    throw contractError('mission-dir must be inside a git repository.');
}
function extractFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        throw contractError('sandbox.md must start with YAML frontmatter containing evaluator.command and evaluator.format=json.');
    }
    return {
        frontmatter: match[1] || '',
        body: (match[2] || '').trim(),
    };
}
function parseSimpleYamlFrontmatter(frontmatter) {
    const result = {};
    let currentSection = null;
    for (const rawLine of frontmatter.split(/\r?\n/)) {
        const line = rawLine.replace(/\t/g, '  ');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
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
            section[key] = value;
            continue;
        }
        result[key] = value;
        currentSection = null;
    }
    return result;
}
function parseKeepPolicy(raw) {
    if (raw === undefined)
        return undefined;
    if (typeof raw !== 'string') {
        throw contractError('sandbox.md frontmatter evaluator.keep_policy must be a string when provided.');
    }
    const normalized = raw.trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (normalized === 'pass_only')
        return 'pass_only';
    if (normalized === 'score_improvement')
        return 'score_improvement';
    throw contractError('sandbox.md frontmatter evaluator.keep_policy must be one of: score_improvement, pass_only.');
}
export function parseSandboxContract(content) {
    const { frontmatter, body } = extractFrontmatter(content);
    const parsedFrontmatter = parseSimpleYamlFrontmatter(frontmatter);
    const evaluatorRaw = parsedFrontmatter.evaluator;
    if (!evaluatorRaw || typeof evaluatorRaw !== 'object' || Array.isArray(evaluatorRaw)) {
        throw contractError('sandbox.md frontmatter must define an evaluator block.');
    }
    const evaluator = evaluatorRaw;
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
export function parseEvaluatorResult(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw contractError('Evaluator output must be valid JSON with required boolean pass and optional numeric score.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw contractError('Evaluator output must be a JSON object.');
    }
    const result = parsed;
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
export async function loadAutoresearchMissionContract(missionDirArg) {
    let missionDir = resolve(missionDirArg);
    if (!existsSync(missionDir)) {
        throw contractError(`mission-dir does not exist: ${missionDir}`);
    }
    // Resolve symlinks so the path matches git's canonical output (e.g., /private/var on macOS)
    try {
        missionDir = realpathSync(missionDir);
    }
    catch { /* keep resolved path */ }
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
//# sourceMappingURL=contracts.js.map