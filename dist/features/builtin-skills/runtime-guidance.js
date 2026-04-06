import { isCliAvailable } from '../../team/model-contract.js';
export function detectSkillRuntimeAvailability(detector = isCliAvailable) {
    const safeDetect = (agentType) => {
        try {
            return detector(agentType);
        }
        catch {
            return false;
        }
    };
    return {
        claude: safeDetect('claude'),
        codex: safeDetect('codex'),
        gemini: safeDetect('gemini'),
    };
}
function normalizeSkillName(skillName) {
    return skillName.trim().toLowerCase();
}
function renderPlanRuntimeGuidance(availability) {
    if (!availability.codex) {
        return '';
    }
    return [
        '## Provider Runtime Availability',
        'Codex CLI is installed and available. When `--architect codex` or `--critic codex` flags are present, use `omc ask codex --agent-prompt <role> "<prompt>"` for those passes. Do NOT report Codex as unavailable.',
    ].join('\n');
}
function renderRalphRuntimeGuidance(availability) {
    if (!availability.codex) {
        return '';
    }
    return [
        '## Provider Runtime Availability',
        'Codex CLI is installed and available. When `--critic=codex` is set, use `omc ask codex --agent-prompt critic "<prompt>"` for the approval pass. Do NOT report Codex as unavailable.',
    ].join('\n');
}
function renderDeepInterviewRuntimeGuidance(availability) {
    if (!availability.codex) {
        return '';
    }
    return [
        '## Provider-Aware Execution Recommendations',
        'When Phase 5 presents post-interview execution choices, keep the Claude-only defaults above and add these Codex variants because Codex CLI is available:',
        '',
        '- `/ralplan --architect codex "<spec or task>"` — Codex handles the architect pass; best for implementation-heavy design review; higher cost than Claude-only ralplan.',
        '- `/ralplan --critic codex "<spec or task>"` — Codex handles the critic pass; cheaper than moving the full loop off Claude; strong second-opinion review.',
        '- `/ralph --critic codex "<spec or task>"` — Ralph still executes normally, but final verification goes through the Codex critic; smallest multi-provider upgrade.',
        '',
        'If Codex becomes unavailable, briefly note that and fall back to the Claude-only recommendations already listed in Phase 5.',
    ].join('\n');
}
export function renderSkillRuntimeGuidance(skillName, availability) {
    switch (normalizeSkillName(skillName)) {
        case 'deep-interview':
            return renderDeepInterviewRuntimeGuidance(availability ?? detectSkillRuntimeAvailability());
        case 'ralplan':
        case 'omc-plan':
        case 'plan':
            return renderPlanRuntimeGuidance(availability ?? detectSkillRuntimeAvailability());
        case 'ralph':
            return renderRalphRuntimeGuidance(availability ?? detectSkillRuntimeAvailability());
        default:
            return '';
    }
}
//# sourceMappingURL=runtime-guidance.js.map