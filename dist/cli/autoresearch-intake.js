import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
const BLOCKED_EVALUATOR_PATTERNS = [
    /<[^>]+>/i,
    /\bTODO\b/i,
    /\bTBD\b/i,
    /REPLACE_ME/i,
    /CHANGEME/i,
    /your-command-here/i,
];
const DEEP_INTERVIEW_DRAFT_PREFIX = 'deep-interview-autoresearch-';
const AUTORESEARCH_ARTIFACT_DIR_PREFIX = 'autoresearch-';
export const AUTORESEARCH_DEEP_INTERVIEW_RESULT_KIND = 'omc.autoresearch.deep-interview/v1';
function defaultDraftEvaluator(topic) {
    const detail = topic.trim() || 'the mission';
    return `TODO replace with evaluator command for: ${detail}`;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractMarkdownSection(markdown, heading) {
    const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'im');
    const match = pattern.exec(markdown);
    if (!match || match.index < 0)
        return '';
    const start = match.index + match[0].length;
    const remainder = markdown.slice(start);
    const nextHeading = remainder.search(/^##\s+/m);
    return (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
}
function parseLaunchReadinessSection(section) {
    const normalized = section.trim();
    if (!normalized) {
        return { launchReady: false, blockedReasons: ['Launch readiness section is missing.'] };
    }
    const launchReady = /Launch-ready:\s*yes/i.test(normalized);
    const blockedReasons = launchReady
        ? []
        : normalized
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^-\s+/.test(line))
            .map((line) => line.replace(/^-\s+/, '').trim())
            .filter(Boolean);
    return { launchReady, blockedReasons };
}
function normalizeKeepPolicy(raw) {
    return raw.trim().toLowerCase() === 'pass_only' ? 'pass_only' : 'score_improvement';
}
function buildArtifactDir(repoRoot, slug) {
    return join(getOmcRoot(repoRoot), 'specs', `${AUTORESEARCH_ARTIFACT_DIR_PREFIX}${slug}`);
}
function buildDraftArtifactPath(repoRoot, slug) {
    return join(getOmcRoot(repoRoot), 'specs', `${DEEP_INTERVIEW_DRAFT_PREFIX}${slug}.md`);
}
function buildResultPath(repoRoot, slug) {
    return join(buildArtifactDir(repoRoot, slug), 'result.json');
}
export function buildMissionContent(topic) {
    return `# Mission\n\n${topic}\n`;
}
export function buildSandboxContent(evaluatorCommand, keepPolicy) {
    const safeCommand = evaluatorCommand.replace(/[\r\n]/g, ' ').trim();
    const keepPolicyLine = keepPolicy ? `\n  keep_policy: ${keepPolicy}` : '';
    return `---\nevaluator:\n  command: ${safeCommand}\n  format: json${keepPolicyLine}\n---\n`;
}
export function isLaunchReadyEvaluatorCommand(command) {
    const normalized = command.trim();
    if (!normalized) {
        return false;
    }
    return !BLOCKED_EVALUATOR_PATTERNS.some((pattern) => pattern.test(normalized));
}
function buildLaunchReadinessSection(launchReady, blockedReasons) {
    if (launchReady) {
        return 'Launch-ready: yes\n- Evaluator command is concrete and can be compiled into sandbox.md';
    }
    return [
        'Launch-ready: no',
        ...blockedReasons.map((reason) => `- ${reason}`),
    ].join('\n');
}
export function buildAutoresearchDraftArtifactContent(compileTarget, seedInputs, launchReady, blockedReasons) {
    const seedTopic = seedInputs.topic?.trim() || '(none)';
    const seedEvaluator = seedInputs.evaluatorCommand?.trim() || '(none)';
    const seedKeepPolicy = seedInputs.keepPolicy || '(none)';
    const seedSlug = seedInputs.slug?.trim() || '(none)';
    return [
        `# Deep Interview Autoresearch Draft — ${compileTarget.slug}`,
        '',
        '## Mission Draft',
        compileTarget.topic,
        '',
        '## Evaluator Draft',
        compileTarget.evaluatorCommand,
        '',
        '## Keep Policy',
        compileTarget.keepPolicy,
        '',
        '## Session Slug',
        compileTarget.slug,
        '',
        '## Seed Inputs',
        `- topic: ${seedTopic}`,
        `- evaluator: ${seedEvaluator}`,
        `- keep_policy: ${seedKeepPolicy}`,
        `- slug: ${seedSlug}`,
        '',
        '## Launch Readiness',
        buildLaunchReadinessSection(launchReady, blockedReasons),
        '',
        '## Confirmation Bridge',
        '- refine further',
        '- launch',
        '',
    ].join('\n');
}
export async function writeAutoresearchDraftArtifact(input) {
    const topic = input.topic.trim();
    if (!topic) {
        throw new Error('Research topic is required.');
    }
    const slug = slugifyMissionName(input.slug?.trim() || topic);
    const evaluatorCommand = (input.evaluatorCommand?.trim() || defaultDraftEvaluator(topic)).replace(/[\r\n]+/g, ' ').trim();
    const compileTarget = {
        topic,
        evaluatorCommand,
        keepPolicy: input.keepPolicy,
        slug,
        repoRoot: input.repoRoot,
    };
    const blockedReasons = [];
    if (!isLaunchReadyEvaluatorCommand(evaluatorCommand)) {
        blockedReasons.push('Evaluator command is still a placeholder/template and must be replaced before launch.');
    }
    if (blockedReasons.length === 0) {
        parseSandboxContract(buildSandboxContent(evaluatorCommand, input.keepPolicy));
    }
    const launchReady = blockedReasons.length === 0;
    const specsDir = join(getOmcRoot(input.repoRoot), 'specs');
    await mkdir(specsDir, { recursive: true });
    const path = buildDraftArtifactPath(input.repoRoot, slug);
    const content = buildAutoresearchDraftArtifactContent(compileTarget, input.seedInputs || {}, launchReady, blockedReasons);
    await writeFile(path, content, 'utf-8');
    return { compileTarget, path, content, launchReady, blockedReasons };
}
export async function writeAutoresearchDeepInterviewArtifacts(input) {
    const draft = await writeAutoresearchDraftArtifact(input);
    const artifactDir = buildArtifactDir(input.repoRoot, draft.compileTarget.slug);
    await mkdir(artifactDir, { recursive: true });
    const missionArtifactPath = join(artifactDir, 'mission.md');
    const sandboxArtifactPath = join(artifactDir, 'sandbox.md');
    const resultPath = buildResultPath(input.repoRoot, draft.compileTarget.slug);
    const missionContent = buildMissionContent(draft.compileTarget.topic);
    const sandboxContent = buildSandboxContent(draft.compileTarget.evaluatorCommand, draft.compileTarget.keepPolicy);
    parseSandboxContract(sandboxContent);
    await writeFile(missionArtifactPath, missionContent, 'utf-8');
    await writeFile(sandboxArtifactPath, sandboxContent, 'utf-8');
    const persisted = {
        kind: AUTORESEARCH_DEEP_INTERVIEW_RESULT_KIND,
        compileTarget: draft.compileTarget,
        draftArtifactPath: draft.path,
        missionArtifactPath,
        sandboxArtifactPath,
        launchReady: draft.launchReady,
        blockedReasons: draft.blockedReasons,
    };
    await writeFile(resultPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf-8');
    return {
        compileTarget: draft.compileTarget,
        draftArtifactPath: draft.path,
        missionArtifactPath,
        sandboxArtifactPath,
        resultPath,
        missionContent,
        sandboxContent,
        launchReady: draft.launchReady,
        blockedReasons: draft.blockedReasons,
    };
}
function parseDraftArtifactContent(content, repoRoot, draftArtifactPath) {
    const missionDraft = extractMarkdownSection(content, 'Mission Draft').trim();
    const evaluatorDraft = extractMarkdownSection(content, 'Evaluator Draft').trim().replace(/[\r\n]+/g, ' ');
    const keepPolicyRaw = extractMarkdownSection(content, 'Keep Policy').trim();
    const slugRaw = extractMarkdownSection(content, 'Session Slug').trim();
    const launchReadiness = parseLaunchReadinessSection(extractMarkdownSection(content, 'Launch Readiness'));
    if (!missionDraft) {
        throw new Error(`Missing Mission Draft section in ${draftArtifactPath}`);
    }
    if (!evaluatorDraft) {
        throw new Error(`Missing Evaluator Draft section in ${draftArtifactPath}`);
    }
    const slug = slugifyMissionName(slugRaw || missionDraft);
    const compileTarget = {
        topic: missionDraft,
        evaluatorCommand: evaluatorDraft,
        keepPolicy: normalizeKeepPolicy(keepPolicyRaw || 'score_improvement'),
        slug,
        repoRoot,
    };
    const missionContent = buildMissionContent(compileTarget.topic);
    const sandboxContent = buildSandboxContent(compileTarget.evaluatorCommand, compileTarget.keepPolicy);
    parseSandboxContract(sandboxContent);
    return {
        compileTarget,
        draftArtifactPath,
        missionArtifactPath: join(buildArtifactDir(repoRoot, slug), 'mission.md'),
        sandboxArtifactPath: join(buildArtifactDir(repoRoot, slug), 'sandbox.md'),
        resultPath: buildResultPath(repoRoot, slug),
        missionContent,
        sandboxContent,
        launchReady: launchReadiness.launchReady,
        blockedReasons: launchReadiness.blockedReasons,
    };
}
async function readPersistedResult(resultPath) {
    const raw = await readFile(resultPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.kind !== AUTORESEARCH_DEEP_INTERVIEW_RESULT_KIND) {
        throw new Error(`Unsupported autoresearch deep-interview result payload: ${resultPath}`);
    }
    if (!parsed.compileTarget) {
        throw new Error(`Missing compileTarget in ${resultPath}`);
    }
    const compileTarget = parsed.compileTarget;
    const draftArtifactPath = typeof parsed.draftArtifactPath === 'string' ? parsed.draftArtifactPath : buildDraftArtifactPath(compileTarget.repoRoot, compileTarget.slug);
    const missionArtifactPath = typeof parsed.missionArtifactPath === 'string' ? parsed.missionArtifactPath : join(buildArtifactDir(compileTarget.repoRoot, compileTarget.slug), 'mission.md');
    const sandboxArtifactPath = typeof parsed.sandboxArtifactPath === 'string' ? parsed.sandboxArtifactPath : join(buildArtifactDir(compileTarget.repoRoot, compileTarget.slug), 'sandbox.md');
    if (!existsSync(missionArtifactPath)) {
        throw new Error(`Missing mission artifact: ${missionArtifactPath} — the interview may have been interrupted before all files were written.`);
    }
    if (!existsSync(sandboxArtifactPath)) {
        throw new Error(`Missing sandbox artifact: ${sandboxArtifactPath} — the interview may have been interrupted before all files were written.`);
    }
    const missionContent = await readFile(missionArtifactPath, 'utf-8');
    const sandboxContent = await readFile(sandboxArtifactPath, 'utf-8');
    parseSandboxContract(sandboxContent);
    return {
        compileTarget,
        draftArtifactPath,
        missionArtifactPath,
        sandboxArtifactPath,
        resultPath,
        missionContent,
        sandboxContent,
        launchReady: parsed.launchReady === true,
        blockedReasons: Array.isArray(parsed.blockedReasons)
            ? parsed.blockedReasons.filter((value) => typeof value === 'string' && value.trim().length > 0)
            : [],
    };
}
async function listMarkdownDraftPaths(repoRoot) {
    const specsDir = join(getOmcRoot(repoRoot), 'specs');
    if (!existsSync(specsDir))
        return [];
    const entries = await readdir(specsDir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(DEEP_INTERVIEW_DRAFT_PREFIX) && entry.name.endsWith('.md'))
        .map((entry) => join(specsDir, entry.name));
}
export async function listAutoresearchDeepInterviewResultPaths(repoRoot) {
    const specsDir = join(getOmcRoot(repoRoot), 'specs');
    if (!existsSync(specsDir))
        return [];
    const entries = await readdir(specsDir, { withFileTypes: true });
    const resultPaths = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(AUTORESEARCH_ARTIFACT_DIR_PREFIX))
        .map((entry) => join(specsDir, entry.name, 'result.json'))
        .filter((path) => existsSync(path));
    return resultPaths.sort((left, right) => left.localeCompare(right));
}
async function filterRecentPaths(paths, newerThanMs, excludePaths) {
    const filtered = [];
    for (const path of paths) {
        if (excludePaths?.has(path)) {
            continue;
        }
        if (typeof newerThanMs === 'number') {
            const metadata = await stat(path).catch(() => null);
            if (!metadata || metadata.mtimeMs < newerThanMs) {
                continue;
            }
        }
        filtered.push(path);
    }
    return filtered;
}
export async function resolveAutoresearchDeepInterviewResult(repoRoot, options = {}) {
    const slug = options.slug?.trim() ? slugifyMissionName(options.slug) : null;
    if (slug) {
        const resultPath = buildResultPath(repoRoot, slug);
        if (existsSync(resultPath)) {
            const metadata = await stat(resultPath).catch(() => null);
            if (!metadata || options.newerThanMs == null || metadata.mtimeMs >= options.newerThanMs) {
                return readPersistedResult(resultPath);
            }
        }
        const draftArtifactPath = buildDraftArtifactPath(repoRoot, slug);
        if (existsSync(draftArtifactPath)) {
            const metadata = await stat(draftArtifactPath).catch(() => null);
            if (!metadata || options.newerThanMs == null || metadata.mtimeMs >= options.newerThanMs) {
                const draftContent = await readFile(draftArtifactPath, 'utf-8');
                return parseDraftArtifactContent(draftContent, repoRoot, draftArtifactPath);
            }
        }
        return null;
    }
    const resultPaths = await filterRecentPaths(await listAutoresearchDeepInterviewResultPaths(repoRoot), options.newerThanMs, options.excludeResultPaths);
    const resultEntries = await Promise.all(resultPaths.map(async (path) => ({ path, metadata: await stat(path) })));
    const newestResultPath = resultEntries.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs)[0]?.path;
    if (newestResultPath) {
        return readPersistedResult(newestResultPath);
    }
    const draftPaths = await filterRecentPaths(await listMarkdownDraftPaths(repoRoot), options.newerThanMs);
    const draftEntries = await Promise.all(draftPaths.map(async (path) => ({ path, metadata: await stat(path) })));
    const newestDraftPath = draftEntries.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs)[0]?.path;
    if (!newestDraftPath) {
        return null;
    }
    const draftContent = await readFile(newestDraftPath, 'utf-8');
    return parseDraftArtifactContent(draftContent, repoRoot, newestDraftPath);
}
//# sourceMappingURL=autoresearch-intake.js.map