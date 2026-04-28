/**
 * Skill Parser
 *
 * Parses YAML frontmatter from skill files.
 */
import type { SkillMetadata } from './types.js';
export interface SkillParseResult {
    metadata: Partial<SkillMetadata>;
    content: string;
    valid: boolean;
    errors: string[];
}
/**
 * Parse skill file frontmatter and content.
 */
export declare function parseSkillFile(rawContent: string): SkillParseResult;
/**
 * Parse YAML metadata without external library.
 */
export declare function parseYamlMetadata(yamlContent: string): Partial<SkillMetadata>;
export declare function parseStringValue(value: string): string;
export declare function parseArrayValue(rawValue: string, lines: string[], currentIndex: number): {
    value: string | string[];
    consumed: number;
};
/**
 * Generate YAML frontmatter for a skill.
 */
export declare function generateSkillFrontmatter(metadata: SkillMetadata): string;
//# sourceMappingURL=parser.d.ts.map