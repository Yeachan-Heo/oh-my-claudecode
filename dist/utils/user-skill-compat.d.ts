export interface UserSkillCompatEntry {
    skillName: string;
    sourceSkillPath: string;
}
export declare function ensureClaudeCodeUserSkillCompat(skillName: string, sourceSkillPath: string): boolean;
export declare function listOmcLearnedUserSkills(): UserSkillCompatEntry[];
export declare function syncOmcLearnedUserSkillsForClaudeCode(): string[];
//# sourceMappingURL=user-skill-compat.d.ts.map