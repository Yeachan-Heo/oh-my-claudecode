import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoots: string[] = [];

export interface BoulderStateFixture {
  readonly planPath: string;
  readonly sessionIds?: readonly string[];
  readonly activePlan?: string;
}

export function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-lazycodex-compat-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeProjectRule(root: string): void {
  const ruleDir = join(root, '.github');
  mkdirSync(ruleDir, { recursive: true });
  writeFileSync(join(ruleDir, 'copilot-instructions.md'), 'Use the project parser before changing runtime behavior.\n');
}

export function cleanupTempProjects(): void {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function writeBoulderState(root: string, fixture: BoulderStateFixture | string): void {
  const planPath = typeof fixture === 'string' ? fixture : fixture.planPath;
  const sessionIds = typeof fixture === 'string' ? undefined : fixture.sessionIds;
  const activePlan = typeof fixture === 'string' ? planPath : fixture.activePlan ?? planPath;
  mkdirSync(join(root, '.lazycodex'), { recursive: true });
  writeFileSync(
    join(root, '.lazycodex', 'boulder.json'),
    JSON.stringify({
      schema_version: 2,
      active_work_id: 'work-1',
      works: {
        'work-1': {
          active_plan: activePlan,
          plan_name: 'fixture',
          ...(sessionIds ? { session_ids: sessionIds } : {}),
          status: 'active',
        },
      },
    }),
  );
}

export interface RegistryFixtureResult {
  eventName: string;
  command: string;
  output: Record<string, unknown>;
}

export interface PackedHookFixtureResult {
  packedRoot: string;
  projectRoot: string;
  output: Record<string, unknown>;
}

export function runPackedLazyCodexCompatHookFixture(): PackedHookFixtureResult {
  const packedRoot = mkdtempSync(join(tmpdir(), 'omc-lazycodex-packed-'));
  tempRoots.push(packedRoot);
  mkdirSync(join(packedRoot, 'scripts'), { recursive: true });
  cpSync(join(process.cwd(), 'scripts', 'lazycodex-compat-hook.mjs'), join(packedRoot, 'scripts', 'lazycodex-compat-hook.mjs'));
  cpSync(join(process.cwd(), 'dist'), join(packedRoot, 'dist'), { recursive: true });
  cpSync(join(process.cwd(), 'agents'), join(packedRoot, 'agents'), { recursive: true });
  symlinkSync(join(process.cwd(), 'node_modules'), join(packedRoot, 'node_modules'), 'dir');
  writeFileSync(join(packedRoot, 'package.json'), '{"name":"packed-fixture","type":"module"}\n');

  const projectRoot = makeTempProject();
  const output = execFileSync('node', ['scripts/lazycodex-compat-hook.mjs', 'UserPromptSubmit'], {
    cwd: packedRoot,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: packedRoot },
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: projectRoot,
      session_id: 'packed-session',
      prompt: 'ordinary packaged prompt',
    }),
    encoding: 'utf8',
  });

  return {
    packedRoot,
    projectRoot,
    output: JSON.parse(output) as Record<string, unknown>,
  };
}

export function runRegisteredLazyCodexCompatFixtures(cwd: string): RegistryFixtureResult[] {
  const registry = readJson(join(cwd, 'hooks', 'hooks.json')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  const requiredEvents = ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop', 'SubagentStop'];

  return requiredEvents.map((eventName) => {
    const commands = (registry.hooks?.[eventName] ?? []).flatMap((entry) =>
      (entry.hooks ?? []).flatMap((hook) => hook.command ? [hook.command] : []),
    );
    const command = commands.find((candidate) => candidate.includes('lazycodex-compat-hook.mjs'));
    if (command === undefined) {
      throw new Error(`missing LazyCodex compatibility hook command for ${eventName}`);
    }

    const output = execFileSync('node', ['scripts/lazycodex-compat-hook.mjs', eventName], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: cwd },
      input: JSON.stringify({
        hook_event_name: eventName,
        cwd: makeTempProject(),
        session_id: `registry-${eventName}`,
      }),
      encoding: 'utf8',
    });

    return {
      eventName,
      command,
      output: JSON.parse(output) as Record<string, unknown>,
    };
  });
}
