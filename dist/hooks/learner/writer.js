/**
 * Skill Writer
 *
 * Writes skill files to disk with proper formatting.
 */
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureSkillsDir, getSkillsDir } from './finder.js';
import { generateSkillFrontmatter } from './parser.js';
import { validateExtractionRequest } from './validator.js';
import { DEBUG_ENABLED } from './constants.js';
/**
 * Generate a unique skill ID.
 */
function generateSkillId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `skill-${timestamp}-${random}`;
}
/**
 * Sanitize a string for use as filename.
 */
function sanitizeFilename(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
}
/**
 * Write a new skill from extraction request.
 */
export function writeSkill(request, projectRoot, skillName) {
    // Validate first
    const validation = validateExtractionRequest(request);
    if (!validation.valid) {
        return {
            success: false,
            error: `Quality validation failed: ${validation.missingFields.join(', ')}`,
            validation,
        };
    }
    // Ensure directory exists
    if (!ensureSkillsDir(request.targetScope, projectRoot || undefined)) {
        return {
            success: false,
            error: `Failed to create skills directory for scope: ${request.targetScope}`,
            validation,
        };
    }
    // Generate metadata
    const metadata = {
        id: generateSkillId(),
        name: skillName,
        description: request.problem.slice(0, 200),
        source: 'extracted',
        createdAt: new Date().toISOString(),
        triggers: request.triggers,
        tags: request.tags,
        quality: validation.score,
        usageCount: 0,
    };
    // Generate content
    const frontmatter = generateSkillFrontmatter(metadata);
    const content = `${frontmatter}

# Problem

${request.problem}

# Solution

${request.solution}
`;
    // Write to file
    const filename = `${sanitizeFilename(skillName)}.md`;
    const skillsDir = getSkillsDir(request.targetScope, projectRoot || undefined);
    const filePath = join(skillsDir, filename);
    // Check for duplicates
    if (existsSync(filePath)) {
        return {
            success: false,
            error: `Skill file already exists: ${filename}`,
            validation,
        };
    }
    try {
        writeFileSync(filePath, content);
        return {
            success: true,
            path: filePath,
            validation,
        };
    }
    catch (e) {
        if (DEBUG_ENABLED) {
            console.error('[learner] Error writing skill file:', e);
        }
        return {
            success: false,
            error: `Failed to write skill file: ${e}`,
            validation,
        };
    }
}
/**
 * Check if a skill with similar triggers already exists.
 */
export function checkDuplicateTriggers(triggers, projectRoot) {
    // Import dynamically to avoid circular dependency
    const { loadAllSkills } = require('./loader.js');
    const skills = loadAllSkills(projectRoot);
    const normalizedTriggers = new Set(triggers.map(t => t.toLowerCase()));
    for (const skill of skills) {
        const skillTriggers = skill.metadata.triggers.map((t) => t.toLowerCase());
        const overlap = skillTriggers.filter((t) => normalizedTriggers.has(t));
        if (overlap.length >= triggers.length * 0.5) {
            return {
                isDuplicate: true,
                existingSkillId: skill.metadata.id,
            };
        }
    }
    return { isDuplicate: false };
}
//# sourceMappingURL=writer.js.map