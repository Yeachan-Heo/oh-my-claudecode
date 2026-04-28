import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBuiltinSkills, getBuiltinSkill, listBuiltinSkillNames, clearSkillsCache } from '../features/builtin-skills/skills.js';

describe('Builtin Skills', () => {
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const originalPath = process.env.PATH;
  const originalUserType = process.env.USER_TYPE;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalCwd = process.cwd();
  let tempDirs: string[] = [];

  // Clear cache before each test to ensure fresh loads
  beforeEach(() => {
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE;
    } else {
      process.env.USER_TYPE = originalUserType;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    process.chdir(originalCwd);
    tempDirs = [];
    clearSkillsCache();
  });

  afterEach(() => {
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE;
    } else {
      process.env.USER_TYPE = originalUserType;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
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
    it('should return correct number of skills (34 canonical + 1 alias)', () => {
      const skills = createBuiltinSkills();
      // 35 entries: 34 canonical skills + 1 deprecated alias (psm)
      expect(skills).toHaveLength(35);
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
      const expectedSkills = [
        'ask',
        'ai-slop-cleaner',
        'autoresearch',
        'autopilot',
        'cancel',
        'ccg',
        'configure-notifications',
        'deep-dive',
        'deep-interview',
        'deepinit',
        'omc-doctor',
        'external-context',
        'hud',
        'learner',
        'mcp-setup',
        'omc-setup',
        'omc-teams',
        'omc-plan',
        'omc-reference',
        'project-session-manager',
        'psm',
        'ralph',
        'ralplan',
        'release',
        'sciomc',
        'self-improve',
        'setup',
        'skill',
        'team',
        'trace',
        'ultraqa',
        'ultrawork',
        'visual-verdict',
        'wiki',
        'writer-memory',
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

    it('stages mcp-setup AskUserQuestion menus so each prompt stays within the current option limit', () => {
      const skill = getBuiltinSkill('mcp-setup');
      expect(skill).toBeDefined();

      const template = skill!.template;
      expect(template).toContain('no more than 3 options per question');

      const blocks = template
        .split(/AskUserQuestion(?: with [^:\n]+)?[:]?/g)
        .slice(1)
        .map((block) => block.split(/## Step|### Step|### For |## Custom MCP Server/)[0]);

      expect(blocks.length).toBeGreaterThanOrEqual(3);

      for (const block of blocks) {
        const optionLines = block
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^\d+\. \*\*/.test(line));
        expect(optionLines.length).toBeLessThanOrEqual(3);
      }

      expect(template).toContain('Recommended starter setup');
      expect(template).toContain('Individual popular server');
      expect(template).toContain('More server choices');
      expect(template).not.toContain('5. **All of the above**');
      expect(template).not.toContain('6. **Custom**');
    });

    it('should emphasize process-first install routing in the setup skill', () => {
      const skill = getBuiltinSkill('setup');
      expect(skill).toBeDefined();
      expect(skill?.description).toContain('install/update routing');
      expect(skill?.template).toContain('Process the request by the **first argument only**');
      expect(skill?.template).toContain('/oh-my-claudecode:setup doctor --json');
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
      expect(skill?.template).toContain('Skill("oh-my-claudecode:autopilot")');
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
      expect(skill?.template).toContain('Skill("oh-my-claudecode:omc-plan")');
      expect(skill?.template).toContain('`--consensus --direct`');
      expect(skill?.template).toContain('`.omc/specs/deep-interview-{slug}.md`');
      expect(skill?.template).toContain('Why now: {one_sentence_targeting_rationale}');
      expect(skill?.template).toContain('cite the repo evidence');
      expect(skill?.template).toContain('Ontology-style question for scope-fuzzy tasks');
      expect(skill?.template).toContain('Every round explicitly names the weakest dimension and why it is the next target');
      expect(skill?.argumentHint).toContain('--autoresearch');
      expect(skill?.template).toContain('zero-learning-curve setup lane for the stateful `autoresearch` skill');
      expect(skill?.template).toContain('Skill("oh-my-claudecode:autoresearch")');
    });

    it('loads deep-interview ambiguityThreshold from settings before state init and updates the announcement copy', () => {
      const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-profile-'));
      const projectDir = mkdtempSync(join(tmpdir(), 'omc-skill-project-'));
      tempDirs.push(profileDir, projectDir);

      process.env.CLAUDE_CONFIG_DIR = profileDir;
      writeFileSync(
        join(profileDir, 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }),
      );

      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.12 } } }),
      );

      process.chdir(projectDir);
      clearSkillsCache();

      const skill = getBuiltinSkill('deep-interview');
      expect(skill).toBeDefined();
      expect(skill?.template).toContain('Load runtime settings');
      expect(skill?.template).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.12`');
      expect(skill?.template).toContain('"threshold": 0.12,');
      expect(skill?.template).toContain('drops below 12%.');
      expect(skill?.template?.indexOf('Load runtime settings')).toBeLessThan(
        skill?.template?.indexOf('Initialize state') ?? Number.POSITIVE_INFINITY,
      );
    });

    it('refreshes cached deep-interview output when the configured threshold changes without requiring manual cache clearing', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'omc-skill-cache-refresh-'));
      tempDirs.push(projectDir);

      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      process.chdir(projectDir);

      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.12 } } }),
      );

      const first = getBuiltinSkill('deep-interview');
      expect(first?.template).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.12`');
      expect(first?.template).toContain('"threshold": 0.12,');

      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.33 } } }),
      );

      const second = getBuiltinSkill('deep-interview');
      expect(second?.template).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.33`');
      expect(second?.template).toContain('"threshold": 0.33,');
      expect(second?.template).not.toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.12`');
      expect(second?.template).not.toContain('"threshold": 0.12,');
    });

    it('replaces all hardcoded 20%/0.2 threshold references in deep-interview template (issue #2545)', () => {
      const profileDir = mkdtempSync(join(tmpdir(), 'omc-skill-2545-'));
      tempDirs.push(profileDir);

      process.env.CLAUDE_CONFIG_DIR = profileDir;
      writeFileSync(
        join(profileDir, 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.15 } } }),
      );

      clearSkillsCache();

      const skill = getBuiltinSkill('deep-interview');
      expect(skill).toBeDefined();
      const t = skill!.template;

      // Previously-fixed references (regression guard)
      expect(t).toContain('"threshold": 0.15,');
      expect(t).toContain('drops below 15%.');

      expect(t).toContain('resolved threshold for this run'); // Purpose/Execution_Policy
      expect(t).toContain('Gate: ≤15% ambiguity');    // ASCII pipeline diagram
      expect(t).toContain('(threshold: 15%)');        // Early-exit example message
      expect(t).toContain('ambiguity ≤ 15%');         // Advanced pipeline description
      expect(t).toContain('"ambiguityThreshold": 0.15,'); // Advanced config snippet

      // Ensure none of the conflicting hardcoded 20% signals remain at those sites
      expect(t).not.toContain('(default: 20%)');
      expect(t).not.toContain('(default 0.2)');
      expect(t).not.toContain('Gate: ≤20% ambiguity');
      expect(t).not.toContain('(threshold: 20%).');
      expect(t).not.toContain('ambiguity ≤ 20%');
      expect(t).not.toContain('"ambiguityThreshold": 0.2,');
    });

    it('ships a config-aware deep-interview SKILL.md for native skill-loader paths (issue #2723)', () => {
      const raw = readFileSync(join(originalCwd, 'skills', 'deep-interview', 'SKILL.md'), 'utf-8');
      expect(raw).toContain('Load runtime settings');
      expect(raw).toContain('Read `[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json` and `./.claude/settings.json`');
      expect(raw).toContain('"threshold": <resolvedThreshold>,');
      expect(raw).toContain('ambiguity drops below <resolvedThresholdPercent>');
      expect(raw).toContain('Gate: ≤<resolvedThresholdPercent> ambiguity');
      expect(raw).toContain('"ambiguityThreshold": <resolvedThreshold>,');
      expect(raw).toContain('At or below the resolved threshold');
      expect(raw).toContain('Normalize oversized initial context before state init');
      expect(raw).toContain('prompt-safe initial-context summary');
      expect(raw).toContain('Wait until the summary exists before ambiguity scoring');
      expect(raw).toContain('Do not ask the next `AskUserQuestion`, score ambiguity, or hand off to execution from an over-budget raw transcript.');
      expect(raw).toContain('Preserve the AskUserQuestion path for OMC-native interaction');

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

    it('loads deep-dive ambiguityThreshold from deep-interview settings before state init and updates threshold copy', () => {
      const profileDir = mkdtempSync(join(tmpdir(), 'omc-deep-dive-profile-'));
      const projectDir = mkdtempSync(join(tmpdir(), 'omc-deep-dive-project-'));
      tempDirs.push(profileDir, projectDir);

      process.env.CLAUDE_CONFIG_DIR = profileDir;
      writeFileSync(
        join(profileDir, 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.18 } } }),
      );

      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ omc: { deepInterview: { ambiguityThreshold: 0.11 } } }),
      );

      process.chdir(projectDir);
      clearSkillsCache();

      const skill = getBuiltinSkill('deep-dive');
      expect(skill).toBeDefined();
      const t = skill!.template;

      expect(t).toContain('Load runtime settings');
      expect(t).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `0.11`');
      expect(t).toContain('"threshold": 0.11,');
      expect(t).toContain('When ambiguity ≤ the resolved threshold for this run');
      expect(t).toContain('Gate: ≤11% ambiguity');
      expect(t).toContain('Interview continues until ambiguity ≤ 11%');
      expect(t.indexOf('Load runtime settings')).toBeLessThan(
        t.indexOf('Initialize state') ?? Number.POSITIVE_INFINITY,
      );
      expect(t).not.toContain('"threshold": 0.2,');
      expect(t).not.toContain('omc.deepDive.ambiguityThreshold');
    });

    it('ships config-aware deep-dive SKILL.md using the deep-interview threshold namespace', () => {
      const raw = readFileSync(join(originalCwd, 'skills', 'deep-dive', 'SKILL.md'), 'utf-8');

      expect(raw).toContain('Load runtime settings');
      expect(raw).toContain('Read `[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json` and `./.claude/settings.json`');
      expect(raw).toContain('Resolve `omc.deepInterview.ambiguityThreshold` into `<resolvedThreshold>`');
      expect(raw).toContain('"threshold": <resolvedThreshold>,');
      expect(raw).toContain('Gate: ≤<resolvedThresholdPercent> ambiguity');
      expect(raw).toContain('Interview continues until ambiguity ≤ <resolvedThresholdPercent>');
      expect(raw).toContain('"deepInterview":');
      expect(raw).toContain('"ambiguityThreshold": <resolvedThreshold>');

      expect(raw).not.toContain('omc.deepDive.ambiguityThreshold');
      expect(raw).not.toContain('"threshold": 0.2,');
      expect(raw).not.toContain('Gate: ≤20% ambiguity');
      expect(raw).not.toContain('ambiguity ≤ 20%');
    });

    it('renders deep-interview summary-gate hardening while preserving AskUserQuestion transport', () => {
      const skill = getBuiltinSkill('deep-interview');
      expect(skill).toBeDefined();
      const t = skill!.template;

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
      } finally {
        if (savedClaudeCode === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = savedClaudeCode;
        if (savedSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
        else process.env.CLAUDE_SESSION_ID = savedSessionId;
        if (savedCodeSessionId === undefined) delete process.env.CLAUDECODE_SESSION_ID;
        else process.env.CLAUDECODE_SESSION_ID = savedCodeSessionId;
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

    it('should expose pipeline metadata for omc-plan handoff into autopilot', () => {
      const skill = getBuiltinSkill('omc-plan');
      expect(skill?.pipeline).toEqual({
        steps: ['deep-interview', 'omc-plan', 'autopilot'],
        nextSkill: 'autopilot',
        handoff: '.omc/plans/ralplan-*.md',
      });
      expect(skill?.template).toContain('## Skill Pipeline');
      expect(skill?.template).toContain('Next skill: `autopilot`');
      expect(skill?.template).toContain('Skill("oh-my-claudecode:autopilot")');
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
      expect(skill?.template).toContain('/oh-my-claudecode:team');
    });

    it('should preserve the multi-repo omc-teams cwd and plan-path contract', () => {
      const skill = getBuiltinSkill('omc-teams');
      expect(skill).toBeDefined();
      expect(skill?.template).toContain('shared workspace root');
      expect(skill?.template).toContain('absolute plan path');
      expect(skill?.template).toContain('--cwd <workspace-root>');
      expect(skill?.template).toContain('Do not anchor the launch cwd to only the repo containing `.omc/plans/...`');
      expect(skill?.template).toContain('single-cwd constraint');
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

      expect(names).toHaveLength(34);
      expect(names).toContain('ai-slop-cleaner');
      expect(names).toContain('ask');
      expect(names).toContain('autopilot');
      expect(names).toContain('autoresearch');
      expect(names).toContain('cancel');
      expect(names).toContain('ccg');
      expect(names).toContain('configure-notifications');
      expect(names).toContain('ralph');
      expect(names).toContain('self-improve');
      expect(names).toContain('ultrawork');
      expect(names).toContain('omc-plan');
      expect(names).toContain('omc-reference');
      expect(names).toContain('deepinit');
      expect(names).toContain('release');
      expect(names).toContain('omc-doctor');
      expect(names).toContain('hud');
      expect(names).toContain('omc-setup');
      expect(names).toContain('setup');
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

      // swarm alias removed in #1131, psm still exists
      expect(names).toHaveLength(35);
      expect(names).toContain('ai-slop-cleaner');
      expect(names).toContain('autoresearch');
      expect(names).toContain('self-improve');
      expect(names).toContain('trace');
      expect(names).toContain('visual-verdict');
      expect(names).toContain('wiki');
      expect(names).not.toContain('swarm');
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
