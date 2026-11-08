import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBuiltinSkills, getBuiltinSkill, listBuiltinSkillNames, clearSkillsCache, renderBundledSkillBody } from '../features/builtin-skills/skills.js';
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
        it('should return correct number of skills (48 canonical + 2 aliases)', () => {
            const skills = createBuiltinSkills();
            // 50 entries: 48 canonical skills + 2 aliases (cancel-ralph, psm)
            expect(skills).toHaveLength(50);
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
            // Surface after the 5.0.0 retirement, including debug/remember/verify
            // which were ungated in 5.0.0.
            const expectedSkills = [
                'ai-slop-cleaner',
                'agent-doc-discipline',
                'architecture-survey',
                'ask',
                'ask-navigator',
                'autopilot',
                'autoresearch',
                'cancel',
                'cancel-ralph',
                'configure-notifications',
                'debug',
                'deep-interview',
                'deepinit',
                'diagram',
                'execute',
                'external-context',
                'graph',
                'harbor',
                'hud',
                'intent',
                'minimal-code-discipline',
                'minimal-prose-discipline',
                'launch',
                'loft',
                'map',
                'drydock',
                'omc-doctor',
                'omc-plan',
                'omc-review',
                'omc-setup',
                'pr',
                'project-session-manager',
                'psm',
                'ralph',
                'ralplan',
                'release',
                'refit',
                'remember',
                'research',
                'self-improve',
                'session-flow',
                'skill',
                'skillify',
                'team',
                'tdd',
                'trace',
                'ultragoal',
                'verify',
                'visual-verdict',
                'wiki',
            ];
            const actualSkillNames = skills.map((s) => s.name);
            expect(actualSkillNames).toEqual(expect.arrayContaining(expectedSkills));
            expect(actualSkillNames.length).toBe(expectedSkills.length);
        });
        it('should not have duplicate skill names', () => {
            const skills = createBuiltinSkills();
            const skillNames = skills.map((s) => s.name);
            const uniqueNames = new Set(skillNames);
            expect(uniqueNames.size).toBe(skillNames.length);
        });
        it('exposes cancel-ralph as a deprecated alias for canonical cancel', () => {
            const cancel = getBuiltinSkill('cancel');
            const cancelRalph = getBuiltinSkill('cancel-ralph');
            expect(cancel).toBeDefined();
            expect(cancel.aliasOf).toBeUndefined();
            expect(cancel.aliases).toContain('cancel-ralph');
            expect(cancelRalph).toBeDefined();
            expect(cancelRalph.aliasOf).toBe('cancel');
            expect(cancelRalph.deprecatedAlias).toBe(true);
            expect(cancelRalph.deprecationMessage).toContain('Use "cancel" instead');
            expect(cancelRalph.template).toBe(cancel.template);
            expect(listBuiltinSkillNames()).toContain('cancel');
            expect(listBuiltinSkillNames()).not.toContain('cancel-ralph');
            expect(listBuiltinSkillNames({ includeAliases: true })).toContain('cancel-ralph');
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
            expect(skill?.template).toContain('multi-entity premise/key-assumption mismatches');
            expect(skill?.template).toContain('single dimensional key across distinct entities, tenants, streams, or groups');
            expect(skill?.template).toContain('verification-methodology defect');
        });
        it('should retrieve tdd as a canonical skill', () => {
            const skill = getBuiltinSkill('tdd');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('tdd');
            expect(skill?.aliasOf).toBeUndefined();
        });
        it('should expose approval-gated pipeline metadata for deep-interview handoff into omc-plan', () => {
            const skill = getBuiltinSkill('deep-interview');
            expect(skill?.pipeline).toEqual({
                steps: ['deep-interview', 'plan'],
                nextSkill: undefined,
                nextSkillArgs: undefined,
                handoff: '.omc/specs/deep-interview-{slug}.md',
                handoffRequiresApproval: true,
            });
            expect(skill?.template).toContain('## Skill Pipeline');
            expect(skill?.template).toContain('Pipeline: `deep-interview → plan`');
            expect(skill?.template).toContain('This stage is approval-gated');
            expect(skill?.template).toContain('unless the user explicitly approves that next step');
            expect(skill?.template).not.toContain('Pipeline: `deep-interview → plan → autopilot`');
            expect(skill?.template).not.toContain('Next skill: `plan`');
            expect(skill?.template).not.toContain('3. Invoke Skill("oh-my-claudecode:plan")');
            expect(skill?.template).toContain('Only after the user selects this option, invoke `Skill("oh-my-claudecode:plan")`');
            expect(skill?.template).toContain('do not automatically invoke autopilot or any other execution skill');
            expect(skill?.template).toContain('`.omc/specs/deep-interview-{slug}.md`');
            expect(skill?.template).toContain('Why now: {one_sentence_targeting_rationale}');
            expect(skill?.template).toContain('cite the repo evidence');
            expect(skill?.template).toContain('Ontology-style question for scope-fuzzy tasks');
            expect(skill?.template).toContain('Every round explicitly names the weakest dimension and why it is the next target');
            expect(skill?.argumentHint).toContain('--autoresearch');
            expect(skill?.template).toContain('zero-learning-curve setup lane for the stateful `autoresearch` skill');
            expect(skill?.template).toContain('Skill("oh-my-claudecode:autoresearch")');
        });
        it('documents deep-interview Round 0 topology locking and multi-component scoring (issue #2919)', () => {
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            const t = skill.template;
            const fourComponentFixture = [
                'Ingestion',
                'Normalization',
                'Review UI',
                'Export',
            ];
            expect(t).toContain('Round 0: Topology Enumeration Gate');
            expect(t).toContain('before any Phase 2 ambiguity scoring');
            expect(t).toContain('"topology": {');
            expect(t).toContain('"confirmed_at": null');
            expect(t).toContain('"components": []');
            expect(t).toContain('"last_targeted_component_id": null');
            expect(t).toContain('"status": "legacy_missing"');
            expect(t).toContain('score every active component independently');
            expect(t).toContain('rotate targeting across active components');
            expect(t).toContain('topology.last_targeted_component_id');
            expect(t).toContain('## Topology');
            expect(t).toContain('user-confirmed deferral reason');
            expect(t).toContain('Phase 4 must cover each confirmed component in `## Topology` or explicitly list a user-confirmed deferral');
            expect(t).toContain('Review UI` is the one detailed component');
            expect(t).toContain('must not collapse or stand in for the less-detailed sibling components');
            expect(t).toContain('until every active component has sufficient goal/constraint/criteria clarity');
            expect(t).toContain('cover each confirmed component in `## Topology`');
            for (const component of fourComponentFixture) {
                expect(t).toContain(component);
            }
        });
        it('loads deep-interview ambiguityThreshold source before state init and updates the first-line marker', () => {
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
            expect(skill?.template).toContain('Phase 0: Resolve Ambiguity Threshold (blocking prerequisite)');
            expect(skill?.template).toContain('Deep Interview threshold: 12% (source: ./.claude/settings.json)');
            expect(skill?.template).toContain('"threshold": 0.12,');
            expect(skill?.template).toContain('"threshold_source": "./.claude/settings.json",');
            expect(skill?.template).toContain('drops below 12%.');
            expect(skill?.template).toContain('- Threshold Source: ./.claude/settings.json');
            expect(skill?.template).not.toContain('3.5. **Load runtime settings** from `~/.claude/settings.json`');
            expect(skill?.template).toContain('settings files were read, threshold was resolved');
            expect(skill?.template?.indexOf('Phase 0: Resolve Ambiguity Threshold')).toBeLessThan(skill?.template?.indexOf('Initialize state') ?? Number.POSITIVE_INFINITY);
        });
        it('refreshes cached deep-interview output when the configured threshold changes without requiring manual cache clearing', () => {
            const projectDir = mkdtempSync(join(tmpdir(), 'omc-skill-cache-refresh-'));
            tempDirs.push(projectDir);
            mkdirSync(join(projectDir, '.claude'), { recursive: true });
            process.chdir(projectDir);
            writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.12 } } }));
            const first = getBuiltinSkill('deep-interview');
            expect(first?.template).toContain('Deep Interview threshold: 12% (source: ./.claude/settings.json)');
            expect(first?.template).toContain('"threshold": 0.12,');
            expect(first?.template).toContain('"threshold_source": "./.claude/settings.json",');
            writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.33 } } }));
            const second = getBuiltinSkill('deep-interview');
            expect(second?.template).toContain('Deep Interview threshold: 33% (source: ./.claude/settings.json)');
            expect(second?.template).toContain('"threshold": 0.33,');
            expect(second?.template).toContain('"threshold_source": "./.claude/settings.json",');
            expect(second?.template).not.toContain('Deep Interview threshold: 12%');
            expect(second?.template).not.toContain('"threshold": 0.12,');
        });
        it('replaces all hardcoded 20%/0.2 threshold references in deep-interview template (issue #2545)', () => {
            const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-2545-'));
            tempDirs.push(profileDir);
            process.env.CLAUDE_CONFIG_DIR = profileDir;
            writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }));
            clearSkillsCache();
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            const t = skill.template;
            // Previously-fixed references (regression guard)
            expect(t).toContain('Deep Interview threshold: 15% (source: [$CLAUDE_CONFIG_DIR|~/.claude]/settings.json)');
            expect(t).toContain('"threshold": 0.15,');
            expect(t).toContain('"threshold_source": "[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json",');
            expect(t).toContain('drops below 15%.');
            expect(t).toContain('resolved threshold for this run'); // Purpose/Execution_Policy
            expect(t).toContain('Gate: ≤15% ambiguity'); // ASCII pipeline diagram
            expect(t).toContain('(threshold: 15%)'); // Early-exit example message
            expect(t).toContain('ambiguity ≤ 15%'); // Advanced pipeline description
            expect(t).toContain('"ambiguityThreshold": 0.15,'); // Advanced config snippet
            // Ensure none of the conflicting hardcoded 20% signals remain at those sites
            expect(t).not.toContain('(default: 20%)');
            expect(t).not.toContain('(default 0.2)');
            expect(t).not.toContain('Gate: ≤20% ambiguity');
            expect(t).not.toContain('(threshold: 20%).');
            expect(t).not.toContain('ambiguity ≤ 20%');
            expect(t).not.toContain('"ambiguityThreshold": 0.2,');
        });
        it('preserves non-OMC hooks when fixing legacy settings hooks (issue #4277)', () => {
            const raw = readFileSync(join(originalCwd, 'skills', 'omc-doctor', 'SKILL.md'), 'utf-8');
            const fingerprintIndex = JSON.parse(readFileSync(join(originalCwd, 'skills', 'omc-doctor', 'node-hook-fingerprints.json'), 'utf-8'));
            const collectNodeHookPaths = (directory, relativeDirectory = 'templates/hooks') => readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }).flatMap((entry) => {
                const relativePath = `${relativeDirectory}/${entry.name}`;
                if (entry.isDirectory())
                    return collectNodeHookPaths(join(directory, entry.name), relativePath);
                return entry.isFile() && entry.name.endsWith('.mjs') ? [relativePath] : [];
            });
            const expectedNodeHookPaths = collectNodeHookPaths(join(originalCwd, 'templates', 'hooks')).sort();
            const indexedHashes = fingerprintIndex.payloads.flatMap(({ fingerprints, workingTree }) => [
                ...fingerprints.map(({ sha256 }) => sha256),
                ...(workingTree ? [workingTree.sha256] : []),
            ]).concat(fingerprintIndex.additionalCommits.map(({ sha256 }) => sha256));
            expect(raw).toContain('ask for explicit confirmation of that scoped change');
            expect(raw).toContain('verify the target is a regular non-symlink file');
            expect(raw).toContain('Create a timestamped backup beside the original with exclusive, no-follow semantics');
            expect(raw).toContain('Give the backup permissions no broader than the source');
            expect(raw).toContain('Write the replacement through a same-directory exclusive/no-follow temporary file and atomic replacement');
            expect(raw).toContain('On Windows, preserve the source ACLs using platform-appropriate operations');
            expect(raw).toContain('If the backup or replacement cannot be kept no broader than the original, leave the settings file untouched and do not apply cleanup');
            expect(raw).toContain('every project-local settings file Claude Code may read');
            expect(raw).toContain('Do not match other scripts merely because they are under a `hooks/` directory');
            expect(raw).toContain('keyword-detector.sh');
            expect(raw).toContain('persistent-mode.sh');
            expect(raw).toContain('session-start.sh');
            expect(raw).toContain('stop-continuation.sh');
            expect(raw).toContain('`bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/silent-auto-update.sh`');
            expect(raw).toContain('If a listed script exists, call it a duplicate only when the active plugin provides the payload\'s canonical or specifically verified equivalent handler under the registration\'s event');
            expect(raw).toContain('standalone Node hook registrations under the active config directory');
            expect(raw).toContain('`keyword-detector`, `persistent-mode`, `session-start`, `session-end`, `pre-tool-use`, `post-tool-use`, `post-tool-use-failure`, `code-simplifier`, or `stop-continuation`');
            expect(raw).toContain('`.cjs` and `.js` variants are legacy too');
            expect(raw).toContain('`node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.mjs"` is a legacy registration');
            expect(raw).toContain('`node "%USERPROFILE%\\.claude\\hooks\\keyword-detector.mjs"`');
            expect(raw).toContain('`%CLAUDE_CONFIG_DIR%\\hooks\\<filename>`');
            expect(raw).toContain('with backslash separators as the same active config directory');
            expect(raw).toContain('Before diagnosing a standalone registration as a duplicate, resolve plugin enablement with the runtime\'s precedence');
            expect(raw).toContain('resolve plugin enablement with the runtime\'s precedence: managed and command-line settings first (read-only), then every applicable project-local settings file resolved above, then the primary working directory\'s `./.claude/settings.json`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`');
            expect(raw).toContain('In a linked Git worktree, inspect the main checkout root\'s `.claude/settings.local.json`, not just the linked worktree\'s file');
            expect(raw).toContain('identify the main checkout with `git worktree list --porcelain`');
            expect(raw).toContain('On Windows, and whenever Claude Code keeps the local file beside the shared `.claude/settings.json`, inspect `.claude/settings.local.json` beside that shared settings file, including in a worktree');
            expect(raw).toContain('Also inspect any starting-directory `.claude/settings.local.json` left by Claude Code versions before 2.1.211; Claude Code can still read it alongside the root file');
            expect(raw).toContain('never ignore a `false` from the effective local file or fall through to a project/profile `true`');
            expect(raw).toContain('If the main checkout root or any applicable local settings file cannot be resolved or read, treat settings and script references as inconclusive and do not remove hooks or scripts');
            expect(raw).toContain('Include every applicable project-local file in the proposal, including main-checkout, Windows side-by-side, and legacy starting-directory files when present');
            expect(raw).toContain('every applicable project-local `.claude/settings.local.json` path resolved above (main-checkout, Windows side-by-side, and legacy starting-directory paths where applicable)');
            expect(raw).toContain('The first scope that explicitly mentions any supported OMC ID decides; unmentioned scopes are transparent');
            expect(raw).toContain('The supported marketplace IDs are `oh-my-claudecode`, `oh-my-claudecode@omc`, and `oh-my-claudecode@oh-my-claudecode`');
            expect(raw).toContain('also consider `oh-my-claudecode@inline` only after the active root\'s `.claude-plugin/plugin.json` has `"name": "oh-my-claudecode"`');
            expect(raw).toContain('Treat that inline plugin as active for the session unless its manifest sets `"defaultEnabled": false` or an applicable settings source disables it; an explicit applicable `true` overrides the manifest default');
            expect(raw).toContain('Within each scope, `enabledPlugins` is canonical, and legacy `plugins` is consulted only if `enabledPlugins` does not mention any supported OMC ID');
            expect(raw).toContain('a canonical `false` overrides a stale legacy `true`, and a higher-precedence `false` overrides any lower-precedence `true`');
            expect(raw).toContain('If applicable local sources conflict and the effective value cannot be determined, supported IDs in the winning field conflict, a relevant file is unreadable or malformed, or no effective enabled result can be established, treat plugin activity as inconclusive and do not auto-remove');
            expect(raw).toContain('`CLAUDE_PLUGIN_ROOT` is only a locator, not proof that a plugin is enabled; an explicit effective `false` always blocks automatic removal');
            expect(raw).toContain('| Legacy Hooks (settings.json) | OK/WARN/CRITICAL | ... |');
            expect(raw).toContain('Inspect every hook source for the active root read-only');
            expect(raw).toContain('the optional `.claude-plugin/plugin.json` `hooks` field accepts a path, an inline hooks object, or an array mixing paths and inline objects');
            expect(raw).toContain('A malformed, unreadable, or unresolved declared source makes event ownership inconclusive');
            expect(raw).toContain('A cached plugin version is insufficient');
            expect(raw).toContain('compare its bytes or SHA-256 with the shipped OMC payload for that exact filename');
            expect(raw).toContain('A matching name or path alone does not prove ownership');
            expect(raw).toContain('| `session-start` | `SessionStart` |');
            expect(raw).toContain('The active plugin must provide the canonical or specifically verified equivalent handler under the registration\'s event, and that handler must replace the payload\'s behavior');
            expect(raw).toContain('a `session-start` script registered under `Stop` is not a duplicate even if the active plugin defines unrelated `Stop` handlers');
            expect(raw).toContain('The tracked historical OMC Bash-hook payload fingerprints (SHA-256) are');
            expect(raw).toContain('keyword-detector.sh`: `abe4dd5e4b16231060166264d271a51e781f08a31c6aa402b26976f9c40d424e`');
            expect(raw).toContain('persistent-mode.sh`: `c131c6846573f0f69b6e39aed1e6db8f05279131a8976f604c1511a46f564ce5`');
            expect(raw).toContain('session-start.sh`: `d87571c326c43cc43b6948aca661a9616faa6943cfe1d1131f482bd30f638134`');
            expect(raw).toContain('stop-continuation.sh`: `f74deb67479c7861b0966bc959ffd3917152b8872ac83d9243a03c7cb707b51f`');
            expect(raw).toContain('any validated retained package under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/omc/oh-my-claudecode/<version>/`');
            expect(raw).toContain('the adjacent `node-hook-fingerprints.json` index');
            expect(raw).toContain('exact stable release-tag provenance for every shipped Node module under `templates/hooks/**/*.mjs`, including hook helpers');
            expect(raw).toContain('search by payload path and inspect only that block rather than loading the entire index');
            expect(raw).toContain('Preserve these additional trusted historical `keyword-detector.mjs` fingerprints');
            expect(raw).toContain('`22d612620f54f360797e42fe608bf7f98155b92a3b0bba187fd89e216395d65a` (`fb125b37`)');
            expect(raw).toContain('`180fc09840baa8ada1661bcc5a13821c9ca802f43ac52cb4e517ca2cba75838a` (`387956a4`)');
            expect(raw).toContain('`71a01806c1b0e29d8e553797de3900b7172654091980ae644d74e5e9291b8af2` (`0b46a595`)');
            expect(fingerprintIndex.schemaVersion).toBe(1);
            expect(fingerprintIndex.provenance.algorithm).toBe('SHA-256');
            expect(fingerprintIndex.provenance.tagCount).toBeGreaterThan(0);
            expect(fingerprintIndex.payloads.map(({ path }) => path)).toEqual(expectedNodeHookPaths);
            expect(indexedHashes.length).toBeGreaterThan(0);
            expect(indexedHashes.every((sha256) => /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
            expect(fingerprintIndex.payloads.every((payload) => payload.fingerprints.every(({ tags }) => tags.length > 0))).toBe(true);
            expect(fingerprintIndex.additionalCommits.map(({ sha256 }) => sha256)).toEqual(expect.arrayContaining([
                '9df91d943d348dbabaaf8f517448192d32648bf64fa78edcc43b8e6bf38e6dd1',
                'ea1dc28c226f168127156bd0d7ffe9c4cb57dc24316f24f13503e9feb6da6b37',
            ]));
            expect(raw).toContain('No tracked OMC payload fingerprint is available for `silent-auto-update.sh` or historical `.js`/`.cjs` variants');
            expect(raw).toContain('If the plugin is inactive, does not provide that event, no payload or fingerprint exists');
            expect(raw).toContain('Never run an unconditional `rm -f` based on basename');
            expect(raw).toContain('plain direct invocation of exactly one listed file');
            expect(raw).toContain('or the exact executable script path alone when the target has execute permission');
            expect(raw).toContain('`$HOME/.claude/hooks/keyword-detector.sh`');
            expect(raw).toContain('No form may include extra arguments, shell operators, or other commands');
            expect(raw).toContain('`bash legacy.sh && run-my-check`');
            expect(raw).toContain('report it for manual cleanup and leave the hook object unchanged');
            expect(raw).toContain('If a composite or ambiguous command mentions a legacy path: WARN - manual cleanup required; never remove it automatically');
            expect(raw).toContain('Match only exact listed filenames invoked with `node`');
            expect(raw).toContain('do not match plugin-root commands or similarly named scripts in other directories');
            expect(raw).toContain('Remove only those matching objects from their `hooks.<event>[].hooks[]` arrays');
            expect(raw).toContain('Preserve every unmatched hook object and every matcher group that still has hooks, including user and third-party hooks');
            expect(raw).toContain('If removing matched objects leaves a matcher group with no hooks, remove that now-empty group');
            expect(raw).toContain('remove an event key when no groups remain and remove the top-level `"hooks"` key when no events remain');
            expect(raw).toContain('For each affected profile-level, project-level, or project-local settings file');
            expect(raw).toContain('Before deleting any script, inspect active session-scoped hook references in skill and subagent frontmatter, enabled plugin manifests, and settings sources');
            expect(raw).toContain('Skill frontmatter hooks remain active for the rest of the session after invocation; subagent frontmatter hooks remain active while that subagent runs');
            expect(raw).toContain('If active skill/subagent sources cannot be conclusively enumerated or read, leave the script in place');
            expect(raw).toContain('If an active hook references the script, keep it until that skill or subagent is no longer active, then repeat the reference check');
            expect(raw).toContain('Claude Code retains the current session\'s hook snapshot after a settings file is edited');
            expect(raw).toContain('keep its script in place until the user restarts Claude Code; never delete a target in the same session that removed its settings hook');
            expect(raw).toContain('In a later session, repeat the complete reference scan and final checks below before deleting the script');
            expect(raw).toContain('Also enumerate every enabled or loaded plugin root, including marketplace plugins and local/inline plugins supplied through `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`');
            expect(raw).toContain('`${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` and its recorded install paths');
            expect(raw).toContain('Read each plugin\'s `.claude-plugin/plugin.json` and `hooks/hooks.json` read-only');
            expect(raw).toContain('Parse the manifest\'s optional `hooks` field as a `.json` path, an inline hooks object, or an array mixing paths and inline objects');
            expect(raw).toContain('If any enabled/loaded plugin root, manifest, or declared hook source cannot be conclusively enumerated, resolved, or read, leave the script in place; if any source references it, leave the script in place');
            expect(raw).toContain('The canonical event and equivalent-handler requirements from Step 2 also gate script deletion; an unrelated plugin handler under the same event cannot justify deleting a standalone payload');
            expect(raw).toContain('The settings scan alone does not establish that no references remain; the active skill/subagent and enabled-plugin manifest scans above must also be complete and clean before deleting the target');
            expect(raw).toContain('If any applicable project-local path, main checkout root, managed source, or command-line source cannot be resolved or inspected, if any source references the script, the user declined the relevant settings change, a file could not be updated, no shipped payload exists, or verification is inconclusive, leave the corresponding script in place');
            expect(raw).toContain('re-check `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, the primary working directory\'s `.claude/settings.json`, every applicable project-local `.claude/settings.local.json` path resolved above (main-checkout, Windows side-by-side, and legacy starting-directory paths where applicable)');
            expect(raw).toContain('Never edit managed settings or MDM/server policy');
            expect(raw).toContain('inspect managed hook sources read-only');
            expect(raw).toContain('/etc/claude-code/managed-settings.json');
            expect(raw).toContain('C:\\Program Files\\ClaudeCode\\managed-settings.json');
            expect(raw).toContain('any applicable MDM, server-managed, or command-line `--settings` sources');
            expect(raw).toContain('no configured hook references remain in any source');
            expect(raw).toContain('If any applicable project-local path, main checkout root, managed source, or command-line source cannot be resolved or inspected');
            expect(raw).not.toContain('Remove the `"hooks"` section');
        });
        it('ships a config-aware deep-interview SKILL.md for native skill-loader paths (issues #2723, #3030)', () => {
            const raw = readFileSync(join(originalCwd, 'skills', 'deep-interview', 'SKILL.md'), 'utf-8');
            expect(raw).toContain('Native Plugin Invocation Guard (Issue #3030)');
            expect(raw).toContain('`/oh-my-claudecode:deep-interview` or `Skill("oh-my-claudecode:deep-interview")`');
            expect(raw).toContain('The user-facing preferred invocation is `/deep-interview`');
            expect(raw).toContain('do not recommend or advertise `/oh-my-claudecode:deep-interview`');
            expect(raw).toContain('Phase 0 below remains blocking');
            expect(raw).toContain('must resolve `omc.deepInterview.ambiguityThreshold` from settings');
            expect(raw).toContain('Phase 0: Resolve Ambiguity Threshold (blocking prerequisite)');
            expect(raw).toContain('User settings: `[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json`');
            expect(raw).toContain('Project settings: `./.claude/settings.json`');
            expect(raw).toContain('"threshold": <resolvedThreshold>,');
            expect(raw).toContain('"threshold_source": "<resolvedThresholdSource>",');
            expect(raw).toContain('Deep Interview threshold: <resolvedThresholdPercent> (source: <resolvedThresholdSource>)');
            expect(raw).toContain('- Threshold Source: <resolvedThresholdSource>');
            expect(raw).toContain('settings files were read, threshold was resolved');
            expect(raw).toContain('ambiguity drops below <resolvedThresholdPercent>');
            expect(raw).toContain('Gate: ≤<resolvedThresholdPercent> ambiguity');
            expect(raw).toContain('"ambiguityThreshold": <resolvedThreshold>,');
            expect(raw).toContain('At or below the resolved threshold');
            expect(raw).toContain('Normalize oversized initial context before state init');
            expect(raw).toContain('prompt-safe initial-context summary');
            expect(raw).toContain('Wait until the summary exists before ambiguity scoring');
            expect(raw).toContain('Do not ask the next `AskUserQuestion`, score ambiguity, or hand off to execution from an over-budget raw transcript.');
            expect(raw).toContain('Preserve the AskUserQuestion path for OMC-native interaction');
            expect(raw).toContain('Consult accumulated local planning knowledge');
            expect(raw).toContain('glob `.omc/specs/deep-*.md` and `.omc/plans/*.md`');
            expect(raw).toContain('before designing Round 1 questions');
            expect(raw).toContain('`.omc/specs/deep-interview-{slug}.md` exactly');
            expect(raw).toContain('Ephemeral interview artifacts');
            expect(raw).toContain('`.omc/state/` or in-memory state via `state_write`');
            expect(raw).toContain('Round 0: Topology Enumeration Gate');
            expect(raw).toContain('before any Phase 2 ambiguity scoring');
            expect(raw).toContain('"topology": {');
            expect(raw).toContain('"confirmed_at": null');
            expect(raw).toContain('"components": []');
            expect(raw).toContain('"last_targeted_component_id": null');
            expect(raw).toContain('"status": "legacy_missing"');
            expect(raw).toContain('rotate targeting across active components');
            expect(raw).toContain('## Topology');
            expect(raw).toContain('Ingestion');
            expect(raw).toContain('Normalization');
            expect(raw).toContain('Review UI');
            expect(raw).toContain('Export');
            expect(raw).toContain('Review UI` is the one detailed component');
            expect(raw).toContain('must not collapse or stand in for the less-detailed sibling components');
            expect(raw).toContain('until every active component has sufficient goal/constraint/criteria clarity');
            expect(raw).toContain('cover each confirmed component in `## Topology`');
            expect(raw).not.toContain('omx question');
            expect(raw).not.toContain('(default: 20%)');
            expect(raw).not.toContain('(default 0.2)');
            expect(raw).not.toContain('"threshold": 0.2,');
            expect(raw).not.toContain('ambiguity drops below 20%');
            expect(raw).not.toContain('Gate: ≤20% ambiguity');
            expect(raw).not.toContain('(threshold: 20%).');
            expect(raw).not.toContain('"ambiguityThreshold": 0.2,');
            expect(raw).not.toContain('ambiguity ≤ 20%');
        });
        it('applies deep-interview runtime settings for plugin-qualified rendered skill names (issue #3030)', () => {
            const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-3030-'));
            tempDirs.push(profileDir);
            process.env.CLAUDE_CONFIG_DIR = profileDir;
            writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.17 } } }));
            clearSkillsCache();
            const rendered = renderBundledSkillBody('oh-my-claudecode:deep-interview', [
                'State:',
                '"threshold": 0.2,',
                'Announcement: We\'ll proceed to execution once ambiguity drops below 20%.',
                'Diagram: Gate: ≤20% ambiguity',
                'Advanced: ambiguity ≤ 20%',
                '"ambiguityThreshold": 0.2,',
            ].join('\n'));
            expect(rendered).toContain('"threshold": 0.17,');
            expect(rendered).toContain('drops below 17%.');
            expect(rendered).toContain('Gate: ≤17% ambiguity');
            expect(rendered).toContain('ambiguity ≤ 17%');
            expect(rendered).toContain('"ambiguityThreshold": 0.17,');
            expect(rendered).not.toContain('"threshold": 0.2,');
            expect(rendered).not.toContain('drops below 20%.');
            expect(rendered).not.toContain('Gate: ≤20% ambiguity');
            expect(rendered).not.toContain('ambiguity ≤ 20%');
            expect(rendered).not.toContain('"ambiguityThreshold": 0.2,');
        });
        it('renders deep-interview summary-gate hardening while preserving AskUserQuestion transport', () => {
            const skill = getBuiltinSkill('deep-interview');
            expect(skill).toBeDefined();
            const t = skill.template;
            expect(t).toContain('Normalize oversized initial context before state init');
            expect(t).toContain('prompt-safe initial-context summary');
            expect(t).toContain('Wait until the summary exists before ambiguity scoring');
            expect(t).toContain('Do not ask the next `AskUserQuestion`, score ambiguity, or hand off to execution from an over-budget raw transcript.');
            expect(t).toContain('Preserve the AskUserQuestion path for OMC-native interaction');
            expect(t).toContain('Initial Context Summarized: {yes|no}');
            expect(t).not.toContain('omx question');
        });
        it('rewrites built-in skill command examples to plugin-safe bridge invocations when omc is unavailable', () => {
            process.env.CLAUDE_PLUGIN_ROOT = '/plugin-root';
            process.env.PATH = '';
            // Simulate a non-Claude-session context: the ask-skill rewriter only keeps
            // `omc ask` form when running *inside* an active Claude session, so we must
            // clear the session-detection vars that may leak in from the test runner.
            const savedClaudeCode = process.env.CLAUDECODE;
            const savedSessionId = process.env.CLAUDE_SESSION_ID;
            const savedCodeSessionId = process.env.CLAUDECODE_SESSION_ID;
            delete process.env.CLAUDECODE;
            delete process.env.CLAUDE_SESSION_ID;
            delete process.env.CLAUDECODE_SESSION_ID;
            clearSkillsCache();
            try {
                const deepInterviewSkill = getBuiltinSkill('deep-interview');
                const askSkill = getBuiltinSkill('ask');
                expect(deepInterviewSkill?.template)
                    .toContain('zero-learning-curve setup lane for the stateful `autoresearch` skill');
                expect(deepInterviewSkill?.template)
                    .toContain('Skill("oh-my-claudecode:autoresearch")');
                expect(askSkill?.template)
                    .toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs ask {{ARGUMENTS}}');
            }
            finally {
                if (savedClaudeCode === undefined)
                    delete process.env.CLAUDECODE;
                else
                    process.env.CLAUDECODE = savedClaudeCode;
                if (savedSessionId === undefined)
                    delete process.env.CLAUDE_SESSION_ID;
                else
                    process.env.CLAUDE_SESSION_ID = savedSessionId;
                if (savedCodeSessionId === undefined)
                    delete process.env.CLAUDECODE_SESSION_ID;
                else
                    process.env.CLAUDECODE_SESSION_ID = savedCodeSessionId;
            }
        });
        it('should retrieve the autoresearch skill by name', () => {
            const skill = getBuiltinSkill('autoresearch');
            expect(skill).toBeDefined();
            expect(skill?.name).toBe('autoresearch');
            expect(skill?.template).toContain('stateful skill for bounded, evaluator-driven iterative improvement');
            expect(skill?.template).toContain('Single-mission only in v1');
            expect(skill?.template).toContain('max-runtime ceiling');
            expect(skill?.template).toContain('per-iteration evaluation JSON');
            expect(skill?.template).toContain('markdown decision logs');
        });
        it('should expose approval-gated omc-plan metadata without an unconditional autopilot handoff', () => {
            const skill = getBuiltinSkill('omc-plan');
            expect(skill?.pipeline).toEqual({
                steps: ['deep-interview'],
                nextSkill: undefined,
                nextSkillArgs: undefined,
                handoff: '.omc/plans/ralplan-*.md',
                handoffRequiresApproval: true,
            });
            expect(skill?.template).toContain('## Skill Pipeline');
            expect(skill?.template).toContain('Pipeline: `deep-interview → omc-plan`');
            expect(skill?.template).toContain('This stage is approval-gated');
            expect(skill?.template).toContain('unless the user explicitly approves that next step');
            expect(skill?.template).not.toContain('Next skill: `autopilot`');
            expect(skill?.template).not.toContain('Skill("oh-my-claudecode:autopilot")');
            expect(skill?.template).not.toContain('3. Invoke Skill("oh-my-claudecode:autopilot")');
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
        it('should expose UI/design AI-slop review signals', () => {
            const skill = getBuiltinSkill('ai-slop-cleaner');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('UI/Design Reviewer Checklist');
            expect(skill?.template).toContain('Korean body copy generally needs at least 14px');
            expect(skill?.template).toContain('box shadows on every surface');
            expect(skill?.template).toContain('eyebrow/title/description');
            expect(skill?.template).toContain('#3B82F6');
            expect(skill?.template).toContain('3- or 4-column uniform grids');
            expect(skill?.template).toContain('extreme gradients');
            expect(skill?.template).toContain('intentional brand');
        });
        it('should accept native Windows psmux before emitting WSL-required team guidance', () => {
            const skill = getBuiltinSkill('team');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('Windows psmux tmux-compatible gate');
            expect(skill?.template).toContain('do **not** tell users that `/team` requires WSL');
            expect(skill?.template).toContain('Treat a successful psmux-backed `tmux -V` as tmux available');
            expect(skill?.template).toContain('continue the normal Team flow; do not emit WSL-required guidance');
            expect(skill?.template).toContain('Only when no tmux-compatible binary is available');
        });
        it('documents fail-closed provider preflight instead of implicit Claude fallback', () => {
            const skill = getBuiltinSkill('team');
            expect(skill).toBeDefined();
            expect(skill?.template).toContain('Missing CLI preflight');
            expect(skill?.template).toContain('strictly preflights only providers that are effective for its initial workers');
            expect(skill?.template).toContain('fails before team state or multiplexer side effects are created');
            expect(skill?.template).toContain('never silently changes a selected role to Claude when its provider is unavailable');
            expect(skill?.template).toContain('fail closed if it is unavailable');
            expect(skill?.template).toContain('omc doctor --team-routing');
            expect(skill?.template).not.toContain('only when the Claude CLI is resolvable');
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
            expect(names).toHaveLength(48);
            expect(names).toContain('ai-slop-cleaner');
            expect(names).toContain('minimal-code-discipline');
            expect(names).toContain('launch');
            expect(names).toContain('loft');
            expect(names).toContain('harbor');
            expect(names).toContain('drydock');
            expect(names).toContain('ask');
            expect(names).toContain('ask-navigator');
            expect(names).toContain('autopilot');
            expect(names).toContain('autoresearch');
            expect(names).toContain('cancel');
            expect(names).toContain('configure-notifications');
            expect(names).toContain('execute');
            expect(names).toContain('self-improve');
            expect(names).toContain('session-flow');
            expect(names).toContain('ultragoal');
            expect(names).toContain('omc-plan');
            expect(names).toContain('deepinit');
            expect(names).toContain('release');
            expect(names).toContain('omc-doctor');
            expect(names).toContain('hud');
            expect(names).toContain('omc-setup');
            expect(names).toContain('tdd');
            expect(names).toContain('trace');
            expect(names).toContain('visual-verdict');
            expect(names).toContain('wiki');
            expect(names).not.toContain('swarm'); // removed in #1131
            expect(names).not.toContain('psm');
        });
        it('should return an array of strings', () => {
            const names = listBuiltinSkillNames();
            names.forEach((name) => {
                expect(typeof name).toBe('string');
            });
        });
        it('should include aliases when explicitly requested', () => {
            const names = listBuiltinSkillNames({ includeAliases: true });
            // swarm alias removed in #1131; learner retired in 5.0.0; cancel-ralph and psm remain
            expect(names).toHaveLength(50);
            expect(names).toContain('ai-slop-cleaner');
            expect(names).toContain('autoresearch');
            expect(names).toContain('self-improve');
            expect(names).toContain('tdd');
            expect(names).toContain('trace');
            expect(names).toContain('ultragoal');
            expect(names).toContain('visual-verdict');
            expect(names).toContain('wiki');
            expect(names).not.toContain('swarm');
            expect(names).toContain('cancel-ralph');
            expect(names).toContain('psm');
        });
    });
    describe('CC native command denylist (issue #830)', () => {
        it('should not expose any builtin skill whose name is a bare CC native command', () => {
            const skills = createBuiltinSkills();
            const bareNativeNames = [
                'compact', 'clear', 'help', 'config', 'plan',
                'review', 'doctor', 'init', 'memory',
            ];
            const skillNames = skills.map((s) => s.name.toLowerCase());
            for (const native of bareNativeNames) {
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
        it('exposes remember/verify/debug to every user (ungated in 5.0.0)', () => {
            process.env.USER_TYPE = '';
            clearSkillsCache();
            const names = listBuiltinSkillNames({ includeAliases: true });
            // verify is a canonical Tier-0 workflow and remember is the retirement
            // target for learner/writer-memory, so neither may be entitlement-gated.
            expect(names).toContain('remember');
            expect(names).toContain('verify');
            expect(names).toContain('debug');
            expect(names).toContain('skillify');
        });
        it('exposes the same skill set when USER_TYPE=ant (entitlement set is empty)', () => {
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