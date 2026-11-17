import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, } from 'fs';
import { basename, join } from 'path';
import { getClaudeConfigDir } from './config-dir.js';
const CLAUDE_SKILLS_DIR = join(getClaudeConfigDir(), 'skills');
const OMC_LEARNED_DIR = join(CLAUDE_SKILLS_DIR, 'omc-learned');
const CLAUDE_SKILL_FILENAME = 'SKILL.md';
function getCompatSkillDir(skillName) {
    return join(CLAUDE_SKILLS_DIR, skillName);
}
function getCompatSkillPath(skillName) {
    return join(getCompatSkillDir(skillName), CLAUDE_SKILL_FILENAME);
}
function isSameSkillContent(sourceSkillPath, targetSkillPath) {
    try {
        return readFileSync(sourceSkillPath, 'utf-8') === readFileSync(targetSkillPath, 'utf-8');
    }
    catch {
        return false;
    }
}
function isCompatSymlinkTarget(sourceSkillPath, targetSkillPath) {
    try {
        return lstatSync(targetSkillPath).isSymbolicLink()
            && readFileSync(sourceSkillPath, 'utf-8') === readFileSync(targetSkillPath, 'utf-8');
    }
    catch {
        return false;
    }
}
export function ensureClaudeCodeUserSkillCompat(skillName, sourceSkillPath) {
    const targetDir = getCompatSkillDir(skillName);
    const targetSkillPath = getCompatSkillPath(skillName);
    if (existsSync(targetSkillPath)) {
        return isCompatSymlinkTarget(sourceSkillPath, targetSkillPath)
            || isSameSkillContent(sourceSkillPath, targetSkillPath);
    }
    if (existsSync(targetDir)) {
        try {
            const existingEntries = readdirSync(targetDir);
            if (existingEntries.length > 0) {
                return false;
            }
        }
        catch {
            return false;
        }
    }
    mkdirSync(targetDir, { recursive: true });
    try {
        symlinkSync(sourceSkillPath, targetSkillPath);
        return true;
    }
    catch {
        try {
            writeFileSync(targetSkillPath, readFileSync(sourceSkillPath, 'utf-8'));
            return true;
        }
        catch {
            try {
                rmSync(targetDir, { recursive: true, force: true });
            }
            catch {
                // Best-effort cleanup for partial compatibility dirs.
            }
            return false;
        }
    }
}
export function listOmcLearnedUserSkills() {
    if (!existsSync(OMC_LEARNED_DIR)) {
        return [];
    }
    const entries = [];
    for (const entry of readdirSync(OMC_LEARNED_DIR, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
            entries.push({
                skillName: basename(entry.name, '.md'),
                sourceSkillPath: join(OMC_LEARNED_DIR, entry.name),
            });
            continue;
        }
        if (!entry.isDirectory()) {
            continue;
        }
        const sourceSkillPath = join(OMC_LEARNED_DIR, entry.name, CLAUDE_SKILL_FILENAME);
        if (!existsSync(sourceSkillPath)) {
            continue;
        }
        entries.push({
            skillName: entry.name,
            sourceSkillPath,
        });
    }
    return entries;
}
export function syncOmcLearnedUserSkillsForClaudeCode() {
    const synced = [];
    for (const entry of listOmcLearnedUserSkills()) {
        if (ensureClaudeCodeUserSkillCompat(entry.skillName, entry.sourceSkillPath)) {
            synced.push(entry.skillName);
        }
    }
    return synced;
}
//# sourceMappingURL=user-skill-compat.js.map