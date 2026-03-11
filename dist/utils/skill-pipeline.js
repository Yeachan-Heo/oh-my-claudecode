import { parseFrontmatterList, stripOptionalQuotes } from './frontmatter.js';
function normalizeSkillReference(value) {
    if (!value)
        return undefined;
    const trimmed = stripOptionalQuotes(value).trim();
    if (!trimmed)
        return undefined;
    return trimmed
        .replace(/^\/oh-my-claudecode:/i, '')
        .replace(/^oh-my-claudecode:/i, '')
        .replace(/^\//, '')
        .trim()
        .toLowerCase() || undefined;
}
function uniqueStrings(values) {
    const seen = new Set();
    const results = [];
    for (const value of values) {
        const normalized = value.trim();
        if (!normalized)
            continue;
        const key = normalized.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        results.push(normalized);
    }
    return results;
}
export function parseSkillPipelineMetadata(frontmatter) {
    const steps = uniqueStrings(parseFrontmatterList(frontmatter.pipeline)
        .map((step) => normalizeSkillReference(step))
        .filter((step) => Boolean(step)));
    const nextSkill = normalizeSkillReference(frontmatter['next-skill']);
    const nextSkillArgs = stripOptionalQuotes(frontmatter['next-skill-args'] ?? '').trim() || undefined;
    const handoff = stripOptionalQuotes(frontmatter.handoff ?? '').trim() || undefined;
    if (steps.length === 0 && !nextSkill && !nextSkillArgs && !handoff) {
        return undefined;
    }
    return {
        steps,
        nextSkill,
        nextSkillArgs,
        handoff,
    };
}
export function renderSkillPipelineGuidance(skillName, pipeline) {
    if (!pipeline) {
        return '';
    }
    const currentSkill = normalizeSkillReference(skillName) ?? skillName.trim().toLowerCase();
    const steps = uniqueStrings([
        ...pipeline.steps,
        currentSkill,
        ...(pipeline.nextSkill ? [pipeline.nextSkill] : []),
    ]);
    const nextInvocation = pipeline.nextSkill
        ? [
            `Skill("oh-my-claudecode:${pipeline.nextSkill}")`,
            pipeline.nextSkillArgs ? `with arguments \`${pipeline.nextSkillArgs}\`` : undefined,
            'using the handoff context from this stage',
        ].filter(Boolean).join(' ')
        : undefined;
    const lines = [
        '## Skill Pipeline',
    ];
    if (steps.length > 0) {
        lines.push(`Pipeline: \`${steps.join(' → ')}\``);
    }
    lines.push(`Current stage: \`${currentSkill}\``);
    if (pipeline.nextSkill) {
        lines.push(`Next skill: \`${pipeline.nextSkill}\``);
    }
    if (pipeline.nextSkillArgs) {
        lines.push(`Next skill arguments: \`${pipeline.nextSkillArgs}\``);
    }
    if (pipeline.handoff) {
        lines.push(`Handoff artifact: \`${pipeline.handoff}\``);
    }
    lines.push('');
    if (pipeline.nextSkill) {
        lines.push('When this stage completes:');
        if (pipeline.handoff) {
            lines.push(`1. Write or update the handoff artifact at \`${pipeline.handoff}\`.`);
        }
        else {
            lines.push('1. Write a concise handoff note before moving to the next skill.');
        }
        lines.push('2. Carry forward the concrete output, decisions made, and remaining risks or assumptions.');
        lines.push(`3. Invoke ${nextInvocation}.`);
    }
    else {
        lines.push('This is the terminal stage in the declared skill pipeline. Do not hand off to another skill unless the user explicitly asks.');
    }
    return lines.join('\n');
}
//# sourceMappingURL=skill-pipeline.js.map