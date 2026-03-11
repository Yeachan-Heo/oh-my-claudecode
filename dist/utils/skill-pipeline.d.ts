export interface SkillPipelineMetadata {
    steps: string[];
    nextSkill?: string;
    nextSkillArgs?: string;
    handoff?: string;
}
export declare function parseSkillPipelineMetadata(frontmatter: Record<string, string>): SkillPipelineMetadata | undefined;
export declare function renderSkillPipelineGuidance(skillName: string, pipeline: SkillPipelineMetadata | undefined): string;
//# sourceMappingURL=skill-pipeline.d.ts.map