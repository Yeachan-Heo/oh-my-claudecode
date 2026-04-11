/**
 * Tests for `runInteractiveWizard()` — the pre-phase readline wizard used
 * by bare `omc setup` on a TTY.
 *
 * Strategy: drive the wizard with a scripted fake Prompter whose
 * `askSelect/askConfirm/askText/askSecret` methods return pre-programmed
 * answers. Assert on the returned `AnswersFile` shape and on which
 * questions were actually asked (to verify conditional gating).
 */

import { describe, it, expect, vi } from 'vitest';
import { runInteractiveWizard } from '../wizard-prompts.js';
import { buildPreset } from '../preset-builder.js';
import type { Prompter, PrompterSelectOption } from '../prompts.js';

// ---------------------------------------------------------------------------
// Fake prompter
// ---------------------------------------------------------------------------

interface ScriptedAnswers {
  /** Map of question-text-fragment → label to return */
  select?: Array<{ match: string; label: string }>;
  /** Secret answers, in order */
  secrets?: string[];
}

interface RecordedCall {
  kind: 'select' | 'secret' | 'write';
  question: string;
  returned: string;
  /** For `select` calls, the options array passed to askSelect. */
  options?: PrompterSelectOption<string>[];
}

function makeFakePrompter(script: ScriptedAnswers): {
  prompter: Prompter;
  calls: RecordedCall[];
  writes: string[];
} {
  const calls: RecordedCall[] = [];
  const writes: string[] = [];
  const secrets = [...(script.secrets ?? [])];

  const prompter: Prompter = {
    async askSelect<T extends string>(
      question: string,
      options: PrompterSelectOption<T>[],
      defaultValue: T,
    ): Promise<T> {
      const rule = script.select?.find((r) => question.includes(r.match));
      const label = rule?.label ?? defaultValue;
      // Match the option by exact label OR by first-word prefix. First-word
      // matching is what lets existing tests pass rules like
      // `label: 'Global (all projects)'` even when the live wizard renders
      // labels as `'Global → /fixture/…/CLAUDE.md'`: both labels start with
      // the word 'Global', so the test rule stays robust against runtime
      // label rewrites that inject resolved paths.
      const firstWord = (s: string): string =>
        s.split(/[\s(—→]/).filter((p) => p.length > 0)[0] ?? s;
      const hit = options.find(
        (o) => o.label === label || firstWord(o.label) === firstWord(label),
      );
      const returned = (hit?.label ?? defaultValue) as T;
      calls.push({
        kind: 'select',
        question,
        returned,
        options: options as PrompterSelectOption<string>[],
      });
      return returned;
    },
    async askConfirm(question: string, defaultValue: boolean): Promise<boolean> {
      calls.push({ kind: 'select', question, returned: String(defaultValue) });
      return defaultValue;
    },
    async askText(question: string, defaultValue = ''): Promise<string> {
      calls.push({ kind: 'select', question, returned: defaultValue });
      return defaultValue;
    },
    async askSecret(question: string): Promise<string> {
      const value = secrets.shift() ?? '';
      calls.push({ kind: 'secret', question, returned: value });
      return value;
    },
    write(message: string): void {
      writes.push(message);
      calls.push({ kind: 'write', question: message, returned: '' });
    },
    close(): void {
      // no-op
    },
  };

  return { prompter, calls, writes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInteractiveWizard', () => {
  it('happy path: all 11 questions asked when everything is enabled', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Global (all projects)' },
        // installStyle asked because detectInstallStyleNeeded returns true
        { match: 'will change your base Claude config', label: 'Overwrite base CLAUDE.md (Recommended)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'Yes, configure MCP servers' },
        { match: 'enable agent teams', label: 'Yes, enable teams (Recommended)' },
        { match: 'How should teammates be displayed', label: 'Auto (Recommended)' },
        { match: 'How many agents should teams spawn', label: '3 agents (Recommended)' },
        { match: 'Which agent type should teammates', label: 'executor (Recommended)' },
        { match: 'support the project by starring it', label: 'Yes, star it!' },
      ],
      secrets: ['exa-key-value', 'gh-token-value'],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => true,
    });

    expect(answers.target).toBe('global');
    expect(answers.installStyle).toBe('overwrite');
    expect(answers.executionMode).toBe('ultrawork');
    expect(answers.installCli).toBe(true);
    expect(answers.taskTool).toBe('builtin');
    expect(answers.mcp?.enabled).toBe(true);
    expect(answers.mcp?.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(answers.mcp?.credentials?.exa).toBe('exa-key-value');
    expect(answers.mcp?.credentials?.github).toBe('gh-token-value');
    expect(answers.mcp?.onMissingCredentials).toBe('install-without-auth');
    expect(answers.teams?.enabled).toBe(true);
    expect(answers.teams?.displayMode).toBe('auto');
    expect(answers.teams?.agentCount).toBe(3);
    expect(answers.teams?.agentType).toBe('executor');
    expect(answers.starRepo).toBe(true);

    // 11 select calls + 2 secret calls
    const selects = calls.filter((c) => c.kind === 'select');
    const secrets = calls.filter((c) => c.kind === 'secret');
    expect(selects.length).toBe(11);
    expect(secrets.length).toBe(2);
  });

  it('returned AnswersFile is valid for buildPreset', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'No - Skip' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => false,
    });

    // Must not throw — exercises the full buildPreset validation pipeline.
    const options = buildPreset(answers);
    expect(options.target).toBe('local');
    expect(options.installStyle).toBe('overwrite');
    expect(options.mcp.enabled).toBe(false);
    expect(options.teams.enabled).toBe(false);
    expect(options.starRepo).toBe(false);
  });

  it('installStyle: skipped when detectInstallStyleNeeded returns false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Global (all projects)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => false,
    });

    expect(answers.target).toBe('global');
    expect(answers.installStyle).toBe('overwrite');

    // installStyle question NOT asked
    const hit = calls.find((c) => c.question.includes('will change your base Claude config'));
    expect(hit).toBeUndefined();
  });

  it('installStyle: skipped when target is local (even if detect returns true)', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const detect = vi.fn(() => true);
    await runInteractiveWizard(prompter, { detectInstallStyleNeeded: detect });

    // installStyle should NOT have been asked because target=local.
    // The wizard may still call `detect` to check for global-only; but
    // mainly we assert the question wasn't asked.
    const hit = calls.find((c) => c.question.includes('will change your base Claude config'));
    expect(hit).toBeUndefined();
  });

  it('teams display/count/type: skipped when teamsEnabled=false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'Yes, star it!' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.teams?.enabled).toBe(false);

    // The three conditional team questions must NOT appear in calls.
    const displayAsked = calls.some((c) => c.question.includes('How should teammates be displayed'));
    const countAsked = calls.some((c) => c.question.includes('How many agents should teams'));
    const typeAsked = calls.some((c) => c.question.includes('Which agent type should teammates'));
    expect(displayAsked).toBe(false);
    expect(countAsked).toBe(false);
    expect(typeAsked).toBe(false);
  });

  it('credential prompts blank → servers installed but credentials omitted', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'Yes, configure MCP servers' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
      secrets: ['', ''], // blank exa + blank github
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.mcp?.enabled).toBe(true);
    expect(answers.mcp?.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(answers.mcp?.credentials?.exa).toBeUndefined();
    expect(answers.mcp?.credentials?.github).toBeUndefined();
    // Install-without-auth preserved so blank-credential servers still install.
    expect(answers.mcp?.onMissingCredentials).toBe('install-without-auth');
  });

  it('MCP credentials: secret prompts skipped entirely when mcpEnabled=false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.mcp?.enabled).toBe(false);
    expect(answers.mcp?.servers).toEqual([]);

    const secretCalls = calls.filter((c) => c.kind === 'secret');
    expect(secretCalls.length).toBe(0);
  });

  it('skipInstallCliQuestion=true: installCli question omitted, resolved as false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        // NO rule for 'install the OMC CLI globally' — the question must
        // not be asked at all when skipInstallCliQuestion=true.
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      skipInstallCliQuestion: true,
    });

    // Resolved as false (don't install; user already has it).
    expect(answers.installCli).toBe(false);

    // The question itself must not appear in the call log.
    const installCliAsked = calls.some((c) =>
      c.question.includes('install the OMC CLI globally'),
    );
    expect(installCliAsked).toBe(false);
  });

  it('defaults: target defaults to global (user can accept without picking)', async () => {
    // Drive the wizard with NO rule for the target question so the fake
    // prompter falls back to defaultValue — which must be the Global
    // option when QUESTION_METADATA.target.default === 'global'.
    const { prompter } = makeFakePrompter({
      select: [
        // No rule for target → wizard picks default = Global
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      // Skip installStyle — we don't want the happy path here.
      detectInstallStyleNeeded: () => false,
      skipInstallCliQuestion: true,
    });

    expect(answers.target).toBe('global');
  });

  it('defaults: mcpEnabled + teamsEnabled + starRepo all default to true (Yes)', async () => {
    // Drive the wizard with NO rules for these three questions so the
    // fake prompter falls back to `defaultValue`. The QUESTION_METADATA
    // defaults should have the wizard mark Yes as the default label,
    // which the fake prompter returns verbatim.
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        // No rules for mcpEnabled, teamsEnabled, starRepo → wizard uses
        // the QUESTION_METADATA.default label. Team sub-questions use
        // their own defaults (auto/3/executor) since teamsEnabled=true.
      ],
      secrets: ['', ''], // mcpEnabled=true → askSecret twice; leave blank.
    });

    const answers = await runInteractiveWizard(prompter, {
      skipInstallCliQuestion: true,
    });

    expect(answers.mcp?.enabled).toBe(true);
    expect(answers.teams?.enabled).toBe(true);
    expect(answers.starRepo).toBe(true);
  });

  it('executionMode "No default" → undefined so buildPreset leaves it unset', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'No default' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.executionMode).toBeUndefined();

    const options = buildPreset(answers);
    expect(options.executionMode).toBeUndefined();
  });

  // --- Config-context banner (CLAUDE_CONFIG_DIR awareness) ----------------

  describe('CLAUDE_CONFIG_DIR awareness', () => {
    function baseScript(): ScriptedAnswers {
      return {
        select: [
          { match: 'Where should I configure', label: 'Global (all projects)' },
          { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
          { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
          { match: 'task management tool', label: 'Built-in Tasks (default)' },
          { match: 'configure MCP servers', label: 'No, skip' },
          { match: 'enable agent teams', label: 'No, skip' },
          { match: 'support the project', label: 'No thanks' },
        ],
      };
    }

    it('prints the config banner BEFORE the first askSelect call', async () => {
      const { prompter, calls, writes } = makeFakePrompter(baseScript());

      await runInteractiveWizard(prompter, {
        detectInstallStyleNeeded: () => false,
        colorEnabled: false,
        configContext: {
          configDir: '/fixture/home/.claude-alt',
          isDefault: false,
          envVarSet: true,
          envVarValue: '/fixture/home/.claude-alt',
          projectDir: '/repo',
          localFiles: [
            '/repo/.claude/CLAUDE.md',
            '/repo/.git/info/exclude',
            '/repo/.claude/skills/omc-reference/SKILL.md',
          ],
          globalFiles: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
          ],
          globalFilesPreserve: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
            '/fixture/home/.claude-alt/CLAUDE-omc.md',
          ],
        },
      });

      // Banner must be emitted at least once.
      expect(writes.length).toBeGreaterThanOrEqual(1);
      const banner = writes[0];
      expect(banner).toContain('omc setup');
      expect(banner).toContain('/fixture/home/.claude-alt');
      expect(banner).toContain('CLAUDE_CONFIG_DIR');
      expect(banner).toContain('/repo/.claude/CLAUDE.md');
      expect(banner).toContain('/fixture/home/.claude-alt/CLAUDE.md');

      // Ordering check: the write call must come BEFORE the first askSelect.
      const firstWriteIdx = calls.findIndex((c) => c.kind === 'write');
      const firstSelectIdx = calls.findIndex((c) => c.kind === 'select');
      expect(firstWriteIdx).toBeGreaterThanOrEqual(0);
      expect(firstSelectIdx).toBeGreaterThan(firstWriteIdx);
    });

    it('Q1 target options show resolved absolute paths (CLAUDE_CONFIG_DIR set)', async () => {
      const { prompter, calls } = makeFakePrompter(baseScript());

      await runInteractiveWizard(prompter, {
        detectInstallStyleNeeded: () => false,
        colorEnabled: false,
        configContext: {
          configDir: '/fixture/home/.claude-alt',
          isDefault: false,
          envVarSet: true,
          envVarValue: '/fixture/home/.claude-alt',
          projectDir: '/repo',
          localFiles: [
            '/repo/.claude/CLAUDE.md',
            '/repo/.git/info/exclude',
            '/repo/.claude/skills/omc-reference/SKILL.md',
          ],
          globalFiles: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
          ],
          globalFilesPreserve: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
            '/fixture/home/.claude-alt/CLAUDE-omc.md',
          ],
        },
      });

      const targetCall = calls.find(
        (c) => c.kind === 'select' && c.question.includes('Where should I configure'),
      );
      expect(targetCall?.options).toBeDefined();
      const options = targetCall?.options ?? [];

      const localOpt = options.find((o) => o.label.startsWith('Local'));
      const globalOpt = options.find((o) => o.label.startsWith('Global'));

      // Paths are embedded in the LABEL (not just description) so they
      // show as the most prominent text on each menu line.
      expect(localOpt?.label).toContain('/repo/.claude/CLAUDE.md');
      expect(globalOpt?.label).toContain('/fixture/home/.claude-alt/CLAUDE.md');

      // Description carries the profile context.
      expect(globalOpt?.description).toContain('CLAUDE_CONFIG_DIR profile');
    });

    it('Q2 installStyle options show resolved CLAUDE.md + companion paths', async () => {
      const { prompter, calls } = makeFakePrompter({
        select: [
          { match: 'Where should I configure', label: 'Global (all projects)' },
          // Q2 is only shown when detectInstallStyleNeeded=true.
          { match: 'will change your base Claude config', label: 'Overwrite base CLAUDE.md (Recommended)' },
          { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
          { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
          { match: 'task management tool', label: 'Built-in Tasks (default)' },
          { match: 'configure MCP servers', label: 'No, skip' },
          { match: 'enable agent teams', label: 'No, skip' },
          { match: 'support the project', label: 'No thanks' },
        ],
      });

      await runInteractiveWizard(prompter, {
        // Force Q2 on: user picked global AND a non-OMC base CLAUDE.md exists.
        detectInstallStyleNeeded: () => true,
        colorEnabled: false,
        configContext: {
          configDir: '/fixture/home/.claude-alt',
          isDefault: false,
          envVarSet: true,
          envVarValue: '/fixture/home/.claude-alt',
          projectDir: '/repo',
          localFiles: [
            '/repo/.claude/CLAUDE.md',
            '/repo/.git/info/exclude',
            '/repo/.claude/skills/omc-reference/SKILL.md',
          ],
          globalFiles: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
          ],
          globalFilesPreserve: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
            '/fixture/home/.claude-alt/CLAUDE-omc.md',
          ],
        },
      });

      // Q2 question text is now dynamic (includes resolved base path).
      const q2Call = calls.find(
        (c) =>
          c.kind === 'select'
          && c.question.includes('Global setup will modify'),
      );
      expect(q2Call?.options).toBeDefined();
      expect(q2Call?.question).toContain('/fixture/home/.claude-alt/CLAUDE.md');

      const options = q2Call?.options ?? [];
      const overwriteOpt = options.find((o) => o.label.startsWith('Overwrite'));
      const preserveOpt = options.find((o) => o.label.startsWith('Keep'));

      // Overwrite LABEL must name the base path.
      expect(overwriteOpt?.label).toContain(
        '/fixture/home/.claude-alt/CLAUDE.md',
      );

      // Preserve LABEL must name BOTH base + companion paths.
      expect(preserveOpt?.label).toContain(
        '/fixture/home/.claude-alt/CLAUDE.md',
      );
      expect(preserveOpt?.label).toContain(
        '/fixture/home/.claude-alt/CLAUDE-omc.md',
      );
    });

    it('colorEnabled=true emits ANSI red escape sequences in banner write', async () => {
      const { prompter, writes } = makeFakePrompter(baseScript());

      await runInteractiveWizard(prompter, {
        detectInstallStyleNeeded: () => false,
        colorEnabled: true,
        configContext: {
          configDir: '/fixture/home/.claude-alt',
          isDefault: false,
          envVarSet: true,
          envVarValue: '/fixture/home/.claude-alt',
          projectDir: '/repo',
          localFiles: ['/repo/.claude/CLAUDE.md'],
          globalFiles: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
          ],
          globalFilesPreserve: [
            '/fixture/home/.claude-alt/CLAUDE.md',
            '/fixture/home/.claude-alt/.omc-config.json',
            '/fixture/home/.claude-alt/settings.json',
            '/fixture/home/.claude-alt/CLAUDE-omc.md',
          ],
        },
      });

      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(writes[0]).toContain('\x1b[31m');
      expect(writes[0]).toContain('\x1b[0m');
    });

    it('Q1 target options omit CLAUDE_CONFIG_DIR hint when env var is not set', async () => {
      const { prompter, calls } = makeFakePrompter(baseScript());

      await runInteractiveWizard(prompter, {
        detectInstallStyleNeeded: () => false,
        colorEnabled: false,
        configContext: {
          configDir: '/fixture/home/.claude-default',
          isDefault: true,
          envVarSet: false,
          envVarValue: undefined,
          projectDir: '/repo',
          localFiles: [
            '/repo/.claude/CLAUDE.md',
            '/repo/.git/info/exclude',
            '/repo/.claude/skills/omc-reference/SKILL.md',
          ],
          globalFiles: [
            '/fixture/home/.claude-default/CLAUDE.md',
            '/fixture/home/.claude-default/.omc-config.json',
            '/fixture/home/.claude-default/settings.json',
          ],
          globalFilesPreserve: [
            '/fixture/home/.claude-default/CLAUDE.md',
            '/fixture/home/.claude-default/.omc-config.json',
            '/fixture/home/.claude-default/settings.json',
            '/fixture/home/.claude-default/CLAUDE-omc.md',
          ],
        },
      });

      const targetCall = calls.find(
        (c) => c.kind === 'select' && c.question.includes('Where should I configure'),
      );
      const options = targetCall?.options ?? [];
      const globalOpt = options.find((o) => o.label.startsWith('Global'));

      // Default profile: path in label, no CLAUDE_CONFIG_DIR hint in description.
      expect(globalOpt?.label).toContain('/fixture/home/.claude-default/CLAUDE.md');
      expect(globalOpt?.description).not.toContain('CLAUDE_CONFIG_DIR');
    });
  });
});
