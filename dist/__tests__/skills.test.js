import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBuiltinSkills, getBuiltinSkill, listBuiltinSkillNames, clearSkillsCache } from '../features/builtin-skills/skills.js';
import { CC_NATIVE_COMMAND_NAMES, EXPECTED_BUILTIN_SKILL_NAMES, EXPECTED_CANONICAL_SKILL_NAMES, EXPECTED_SKILL_ALIASES, REMOVED_SKILL_NAMES, } from './registry-contract-fixtures.js';
describe('Builtin Skills', () => {
    const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const originalPath = process.env.PATH;
    const originalUserType = process.env.USER_TYPE;
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalCwd = process.cwd();
    let tempDirs = [];
    // Clear cache before each test to ensure fresh loads
    beforeEach(() => {
        if (originalPluginRoot === undefined) {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        else {
            process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
        }
        if (originalPath === undefined) {
            delete process.env.PATH;
        }
        else {
            process.env.PATH = originalPath;
        }
        if (originalUserType === undefined) {
            delete process.env.USER_TYPE;
        }
        else {
            process.env.USER_TYPE = originalUserType;
        }
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        process.chdir(originalCwd);
        tempDirs = [];
        clearSkillsCache();
    });
    afterEach(() => {
        if (originalPluginRoot === undefined) {
            delete process.env.CLAUDE_PLUGIN_ROOT;
        }
        else {
            process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
        }
        if (originalPath === undefined) {
            delete process.env.PATH;
        }
        else {
            process.env.PATH = originalPath;
        }
        if (originalUserType === undefined) {
            delete process.env.USER_TYPE;
        }
        else {
            process.env.USER_TYPE = originalUserType;
        }
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        process.chdir(originalCwd);
        for (const dir of tempDirs) {
            rmSync(dir, { recursive: true, force: true });
        }
        tempDirs = [];
        clearSkillsCache();
    });
    describe('createBuiltinSkills()', () => {
        it('should return the expected LazyCodex-compatible skills and aliases', () => {
            const skills = createBuiltinSkills();
            expect(skills).toHaveLength(EXPECTED_BUILTIN_SKILL_NAMES.length);
        });
        it('should return an array of BuiltinSkill objects', () => {
            const skills = createBuiltinSkills();
            expect(Array.isArray(skills)).toBe(true);
            expect(skills.length).toBeGreaterThan(0);
        });
    });
    describe('Skill properties', () => {
        const skills = createBuiltinSkills();
        it('should have required properties (name, description, template)', () => {
            skills.forEach((skill) => {
                expect(skill).toHaveProperty('name');
                expect(skill).toHaveProperty('description');
                expect(skill).toHaveProperty('template');
            });
        });
        it('should have non-empty name for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.name).toBeTruthy();
                expect(typeof skill.name).toBe('string');
                expect(skill.name.length).toBeGreaterThan(0);
            });
        });
        it('should have non-empty description for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.description).toBeTruthy();
                expect(typeof skill.description).toBe('string');
                expect(skill.description.length).toBeGreaterThan(0);
            });
        });
        it('should have non-empty template for each skill', () => {
            skills.forEach((skill) => {
                expect(skill.template).toBeTruthy();
                expect(typeof skill.template).toBe('string');
                expect(skill.template.length).toBeGreaterThan(0);
            });
        });
    });
    describe('Skill names', () => {
        it('should have valid skill names', () => {
            const skills = createBuiltinSkills();
            const actualSkillNames = skills.map((s) => s.name);
            expect(actualSkillNames).toEqual(expect.arrayContaining([...EXPECTED_BUILTIN_SKILL_NAMES]));
            expect(actualSkillNames.length).toBe(EXPECTED_BUILTIN_SKILL_NAMES.length);
            for (const name of actualSkillNames) {
                expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
            }
            for (const removedName of REMOVED_SKILL_NAMES) {
                expect(actualSkillNames).not.toContain(removedName);
            }
        });
        it('should not have duplicate skill names', () => {
            const skills = createBuiltinSkills();
            const skillNames = skills.map((s) => s.name);
            const uniqueNames = new Set(skillNames);
            expect(uniqueNames.size).toBe(skillNames.length);
        });
    });
    describe('getBuiltinSkill()', () => {
        it('should retrieve a skill by name', () => {
            const skill = getBuiltinSkill('autopilot');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('autopilot');
        });
        it('should retrieve the ai-slop-cleaner skill by name', () => {
            const skill = getBuiltinSkill('ai-slop-cleaner');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('ai-slop-cleaner');
        });
        it('should surface bundled skill resources for skills with additional files', () => {
            const skill = getBuiltinSkill('project-session-manager');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('## Skill Resources');
            expect(skill?.template).toContain('skills/project-session-manager');
            expect(skill?.template).toContain('`lib/`');
            expect(skill?.template).toContain('`psm.sh`');
        });
        it('should emphasize process-first install routing in the setup skill', () => {
            const skill = getBuiltinSkill('setup');
            expect(skill).toBeDefined();
            expect(skill?.description).toContain('install/update routing');
            expect(skill?.template).toContain('Process the request by the **first argument only**');
            expect(skill?.template).toContain('/lazycc:setup doctor --json');
            expect(skill?.template).not.toContain('{{ARGUMENTS_AFTER_DOCTOR}}');
        });
        it('should emphasize worktree-first guidance in project session manager skill text', () => {
            const skill = getBuiltinSkill('project-session-manager');
            expect(skill).toBeDefined();
            expect(skill?.description).toContain('Worktree-first');
            expect(skill?.template).toContain('Quick Start (worktree-first)');
            expect(skill?.template).toContain('`omc teleport`');
        });
        it('should keep ask as the canonical process-first advisor wrapper', () => {
            const skill = getBuiltinSkill('ask');
            expect(skill).toBeDefined();
            expect(skill?.description).toContain('Process-first advisor routing');
            expect(skill?.template).toContain('omc ask {{ARGUMENTS}}');
            expect(skill?.template).toContain('Do NOT manually construct raw provider CLI commands');
        });
        it('should retrieve the trace skill by name', () => {
            const skill = getBuiltinSkill('trace');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('trace');
            expect(skill?.template).toContain('Claude built-in team mode');
            expect(skill?.template).toContain('3 tracer lanes by default');
            expect(skill?.template).toContain('Ranked Hypotheses');
            expect(skill?.template).toContain('trace_timeline');
            expect(skill?.template).toContain('trace_summary');
        });
        it('should retrieve the deep-dive skill with pipeline metadata and 3-point injection', () => {
            const skill = getBuiltinSkill('deep-dive');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('deep-dive');
            expect(skill?.pipeline).toEqual({
                steps: ['deep-dive', 'omc-plan', 'autopilot'],
                nextSkill: 'omc-plan',
                nextSkillArgs: '--consensus --direct',
                handoff: '.omc/specs/deep-dive-{slug}.md',
            });
            // Verify 3-point injection mechanism
            expect(skill?.template).toContain('3-Point Injection');
            expect(skill?.template).toContain('initial_idea enrichment');
            expect(skill?.template).toContain('codebase_context replacement');
            expect(skill?.template).toContain('initial question queue injection');
            // Verify per-lane critical unknowns (B3 fix)
            expect(skill?.template).toContain('Per-Lane Critical Unknowns');
            // Verify pipeline handoff is fully wired (B1 fix)
            expect(skill?.template).toContain('Skill("lazycc:autopilot")');
            expect(skill?.template).toContain('consensus plan as Phase 0+1 output');
            // Verify untrusted data guard (NB1 fix)
            expect(skill?.template).toContain('trace-context');
            expect(skill?.template).toContain('untrusted data');
            // Verify state schema compatibility (B2 fix)
            expect(skill?.template).toContain('interview_id');
            expect(skill?.template).toContain('challenge_modes_used');
            expect(skill?.template).toContain('ontology_snapshots');
            expect(skill?.template).toContain('explicit weakest-dimension rationale reporting');
            expect(skill?.template).toContain('repo-evidence citation requirement');
        });
        it('should expose pipeline metadata for deep-interview handoff into omc-plan', () => {
            const skill = getBuiltinSkill('deep-interview');
            expect(skill?.pipeline).toEqual({
                steps: ['deep-interview', 'omc-plan', 'autopilot'],
                nextSkill: 'omc-plan',
                nextSkillArgs: '--consensus --direct',
                handoff: '.omc/specs/deep-interview-{slug}.md',
            });
            expect(skill?.template).toContain('## Skill Pipeline');
            expect(skill?.template).toContain('Pipeline: `deep-interview → omc-plan → autopilot`');
            expect(skill?.template).toContain('Skill("lazycc:omc-plan")');
            expect(skill?.template).toContain('`--consensus --direct`');
            expect(skill?.template).toContain('`.omc/specs/deep-interview-{slug}.md`');
            expect(skill?.template).toContain('Why now: {one_sentence_targeting_rationale}');
            expect(skill?.template).toContain('cite the repo evidence');
            expect(skill?.template).toContain('Ontology-style question for scope-fuzzy tasks');
            expect(skill?.template).toContain('Every round explicitly names the weakest dimension and why it is the next target');
            expect(skill?.argumentHint).toContain('--autoresearch');
            expect(skill?.template).toContain('zero-learning-curve setup lane for `omc autoresearch`');
            expect(skill?.template).toContain('autoresearch --mission "<mission>" --eval "<evaluator>"');
        });
        it('loads deep-interview ambiguityThreshold from settings before state init and updates the announcement copy', () => {
            const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-profile-'));
            const projectDir = mkdtempSync(join(tmpdir(), 'omc-skill-project-'));
            tempDirs.push(profileDir, projectDir);
            process.env.CLAUDE_CONFIG_DIR = profileDir;
            writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }));
            mkdirSync(join(projectDir, '.claude'), { recursive: true });
            writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.12 } } }));
            process.chdir(projectDir);
            clearSkillsCache();
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('Load runtime settings');
            expect(skill?.template).toContain('ambiguityThreshold = 0.12');
            expect(skill?.template).toContain('"threshold": 0.12,');
            expect(skill?.template).toContain('drops below 12%.');
            expect(skill?.template?.indexOf('Load runtime settings')).toBeLessThan(skill?.template?.indexOf('Initialize state') ?? Number.POSITIVE_INFINITY);
        });
        it('rewrites built-in skill command examples to plugin-safe bridge invocations when omc is unavailable', () => {
            process.env.CLAUDE_PLUGIN_ROOT = '/plugin-root';
            process.env.PATH = '';
            clearSkillsCache();
            const deepInterviewSkill = getBuiltinSkill('deep-interview');
            const askSkill = getBuiltinSkill('ask');
            expect(deepInterviewSkill?.template)
                .toContain('zero-learning-curve setup lane for `node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch`');
            expect(deepInterviewSkill?.template)
                .toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "<mission>" --eval "<evaluator>"');
            expect(askSkill?.template)
                .toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask {{ARGUMENTS}}');
        });
        it('should expose pipeline metadata for omc-plan handoff into autopilot', () => {
            const skill = getBuiltinSkill('omc-plan');
            expect(skill?.pipeline).toEqual({
                steps: ['deep-interview', 'omc-plan', 'autopilot'],
                nextSkill: 'autopilot',
                handoff: '.omc/plans/ralplan-*.md',
            });
            expect(skill?.template).toContain('## Skill Pipeline');
            expect(skill?.template).toContain('Next skill: `autopilot`');
            expect(skill?.template).toContain('Skill("lazycc:autopilot")');
            expect(skill?.template).toContain('`.omc/plans/ralplan-*.md`');
        });
        it('should expose review mode guidance for ai-slop-cleaner', () => {
            const skill = getBuiltinSkill('ai-slop-cleaner');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('Review Mode (`--review`)');
            expect(skill?.template).toContain('writer/reviewer separation');
        });
        it('should include the ai-slop-cleaner review workflow', () => {
            const skill = getBuiltinSkill('ai-slop-cleaner');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('--review');
            expect(skill?.template).toContain('Writer pass');
            expect(skill?.template).toContain('Reviewer pass');
        });
        it('should require explicit tmux prerequisite checks for omc-teams', () => {
            const skill = getBuiltinSkill('omc-teams');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('command -v tmux >/dev/null 2>&1');
            expect(skill?.template).toContain('Do **not** say tmux is missing');
            expect(skill?.template).toContain('tmux capture-pane -pt <pane-id> -S -20');
        });
        it('should document allowed omc-teams agent types and native team fallback', () => {
            const skill = getBuiltinSkill('omc-teams');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('/omc-teams` only supports **`claude`**, **`codex`**, and **`gemini`**');
            expect(skill?.template).toContain('unsupported type such as `expert`');
            expect(skill?.template).toContain('/lazycc:team');
        });
        it('should be case-insensitive', () => {
            const skillLower = getBuiltinSkill('autopilot');
            const skillUpper = getBuiltinSkill('AUTOPILOT');
            const skillMixed = getBuiltinSkill('AuToPiLoT');
            expect(skillLower).toBeDefined();
            expect(skillUpper).toBeDefined();
            expect(skillMixed).toBeDefined();
            expect(skillLower?.name).toBe(skillUpper?.name);
            expect(skillLower?.name).toBe(skillMixed?.name);
        });
        it('should return undefined for non-existent skill', () => {
            const skill = getBuiltinSkill('non-existent-skill');
            expect(skill).toBeUndefined();
        });
    });
    describe('listBuiltinSkillNames()', () => {
        it('should return canonical skill names by default', () => {
            const names = listBuiltinSkillNames();
            expect(names).toHaveLength(EXPECTED_CANONICAL_SKILL_NAMES.length);
            expect(names).toEqual(expect.arrayContaining([...EXPECTED_CANONICAL_SKILL_NAMES]));
            for (const alias of EXPECTED_SKILL_ALIASES) {
                expect(names).not.toContain(alias);
            }
            for (const removedName of REMOVED_SKILL_NAMES) {
                expect(names).not.toContain(removedName);
            }
        });
        it('should return an array of strings', () => {
            const names = listBuiltinSkillNames();
            names.forEach((name) => {
                expect(typeof name).toBe('string');
            });
        });
        it('should include aliases when explicitly requested', () => {
            const names = listBuiltinSkillNames({ includeAliases: true });
            expect(names).toHaveLength(EXPECTED_BUILTIN_SKILL_NAMES.length);
            expect(names).toEqual(expect.arrayContaining([...EXPECTED_BUILTIN_SKILL_NAMES]));
            for (const removedName of REMOVED_SKILL_NAMES) {
                expect(names).not.toContain(removedName);
            }
        });
    });
    describe('CC native command denylist (issue #830)', () => {
        it('should not expose any builtin skill whose name is a bare CC native command', () => {
            const skills = createBuiltinSkills();
            const skillNames = skills.map((s) => s.name.toLowerCase());
            for (const native of CC_NATIVE_COMMAND_NAMES) {
                expect(skillNames).not.toContain(native);
            }
        });
        it('should not return a skill for "compact" via getBuiltinSkill', () => {
            expect(getBuiltinSkill('compact')).toBeUndefined();
        });
        it('should not return a skill for "clear" via getBuiltinSkill', () => {
            expect(getBuiltinSkill('clear')).toBeUndefined();
        });
    });
    describe('skininthegamebros-only builtin skills', () => {
        it('keeps skininthegamebros-only skills hidden by default', () => {
            const names = listBuiltinSkillNames({ includeAliases: true });
            expect(names).not.toContain('remember');
            expect(names).not.toContain('verify');
            expect(names).not.toContain('debug');
            expect(names).not.toContain('skillify');
        });
        it('surfaces skininthegamebros-only skills when USER_TYPE=ant', () => {
            process.env.USER_TYPE = 'ant';
            clearSkillsCache();
            const names = listBuiltinSkillNames({ includeAliases: true });
            expect(names).toContain('remember');
            expect(names).toContain('verify');
            expect(names).toContain('debug');
            expect(names).toContain('skillify');
            expect(names).not.toContain('stuck');
            expect(names).not.toContain('lorem-ipsum');
        });
    });
    describe('Template strings', () => {
        const skills = createBuiltinSkills();
        it('should have non-empty templates', () => {
            skills.forEach((skill) => {
                expect(skill.template.trim().length).toBeGreaterThan(0);
            });
        });
        it('should have substantial template content (> 100 chars)', () => {
            skills.forEach((skill) => {
                expect(skill.template.length).toBeGreaterThan(100);
            });
        });
    });
});
//# sourceMappingURL=skills.test.js.map