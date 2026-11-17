import { type CliAgentType } from '../../team/model-contract.js';
export interface SkillRuntimeAvailability {
    claude: boolean;
    codex: boolean;
    gemini: boolean;
    grok: boolean;
    antigravity: boolean;
}
export declare function detectSkillRuntimeAvailability(detector?: (agentType: CliAgentType) => boolean): SkillRuntimeAvailability;
export declare function renderSkillRuntimeGuidance(skillName: string, availability?: SkillRuntimeAvailability): string;
//# sourceMappingURL=runtime-guidance.d.ts.map