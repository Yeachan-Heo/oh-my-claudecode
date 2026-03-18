import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';
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
const AUTORESEARCH_DEEP_INTERVIEW_RESULT_KIND = 'omc.autoresearch.deep-interview/v1';
function defaultDraftEvaluator(topic) {
    const detail = topic.trim() || 'the mission';
    return `TODO replace with evaluator command for: ${detail}`;
}
function normalizeKeepPolicy(raw) {
    return raw.trim().toLowerCase() === 'pass_only' ? 'pass_only' : 'score_improvement';
}
function buildArtifactDir(repoRoot, slug) {
    return join(repoRoot, '.omc', 'specs', `${AUTORESEARCH_ARTIFACT_DIR_PREFIX}${slug}`);
}
function buildDraftArtifactPath(repoRoot, slug) {
    return join(repoRoot, '.omc', 'specs', `${DEEP_INTERVIEW_DRAFT_PREFIX}${slug}.md`);
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
function buildAutoresearchDraftArtifactContent(compileTarget, seedInputs, launchReady, blockedReasons) {
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
    const specsDir = join(input.repoRoot, '.omc', 'specs');
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
//# sourceMappingURL=autoresearch-intake.js.map