import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import {
  type AutoresearchKeepPolicy,
  loadAutoresearchMissionContract,
  slugifyMissionName,
} from '../autoresearch/contracts.js';
import {
  assertModeStartAllowed,
  buildAutoresearchRunTag,
  countTrailingAutoresearchNoops,
  finalizeAutoresearchRunState,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
  resumeAutoresearchRuntime,
} from '../autoresearch/runtime.js';
import { guidedAutoresearchSetup, initAutoresearchMission, parseInitArgs, spawnAutoresearchTmux } from './autoresearch-guided.js';
import { type AutoresearchSeedInputs } from './autoresearch-intake.js';

const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';

export const AUTORESEARCH_HELP = `omc autoresearch - Launch OMC autoresearch with thin-supervisor parity semantics

Usage:
  omc autoresearch                                                (launch interactive intake, then background launch)
  omc autoresearch [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]
  omc autoresearch init [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]
  omc autoresearch --mission TEXT --sandbox CMD [--keep-policy P] [--slug S]
  omc autoresearch <mission-dir> [claude-args...]
  omc autoresearch --resume <run-id> [claude-args...]

Arguments:
  (no args)        Launch interactive intake that refines the mission/evaluator, writes .omc/specs
                   artifacts, and launches only after explicit confirmation.
  --topic/...      Seed the intake with draft values; still requires refinement/confirmation before launch.
  init             Bare init is an interactive alias on TTYs; init with flags is the expert scaffold path.
  --mission/       Expert bypass path. --mission is raw mission text and --sandbox is the raw
  --sandbox        evaluator/sandbox command. Both flags are required together; --keep-policy and
                   --slug remain optional only when both are present.
  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md
  <run-id>         Existing autoresearch run id from .omc/logs/autoresearch/<run-id>/manifest.json

Behavior:
  - intake writes canonical artifacts under .omc/specs before launch
  - validates mission.md and sandbox.md
  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json
  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane
  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omc/logs/autoresearch/
  - --resume loads the authoritative per-run manifest and continues from the last kept commit
`;

const AUTORESEARCH_APPEND_INSTRUCTIONS_ENV = 'OMC_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE';
const AUTORESEARCH_MAX_CONSECUTIVE_NOOPS = 3;

export function normalizeAutoresearchClaudeArgs(claudeArgs: readonly string[]): string[] {
  const normalized: string[] = [];
  let hasBypass = false;

  for (const arg of claudeArgs) {
    if (arg === CLAUDE_BYPASS_FLAG) {
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }
    normalized.push(arg);
  }

  if (!hasBypass) {
    normalized.push(CLAUDE_BYPASS_FLAG);
  }

  return normalized;
}

function runAutoresearchTurn(worktreePath: string, instructionsFile: string, claudeArgs: string[]): void {
  const prompt = readFileSync(instructionsFile, 'utf-8');
  const launchArgs = ['--print', ...normalizeAutoresearchClaudeArgs(claudeArgs), '-p', prompt];
  const result = spawnSync('claude', launchArgs, {
    cwd: worktreePath,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
    throw new Error(`autoresearch_claude_exec_failed:${result.status ?? 'unknown'}`);
  }
}

export interface ParsedAutoresearchArgs {
  missionDir: string | null;
  runId: string | null;
  claudeArgs: string[];
  guided?: boolean;
  initArgs?: string[];
  seedArgs?: AutoresearchSeedInputs;
  missionText?: string;
  sandboxCommand?: string;
  keepPolicy?: AutoresearchKeepPolicy;
  slug?: string;
}

function parseAutoresearchKeepPolicy(value: string): AutoresearchKeepPolicy {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pass_only' || normalized === 'score_improvement') {
    return normalized;
  }
  throw new Error('--keep-policy must be one of: score_improvement, pass_only');
}

function parseAutoresearchBypassArgs(args: readonly string[]): ParsedAutoresearchArgs | null {
  let missionText: string | undefined;
  let sandboxCommand: string | undefined;
  let keepPolicy: AutoresearchKeepPolicy | undefined;
  let slug: string | undefined;

  const hasBypassFlag = args.some((arg) =>
    arg === '--mission'
      || arg.startsWith('--mission=')
      || arg === '--sandbox'
      || arg.startsWith('--sandbox='),
  );
  if (!hasBypassFlag) {
    return null;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--mission') {
      if (!next) throw new Error('--mission requires a value.');
      missionText = next;
      i++;
      continue;
    }
    if (arg.startsWith('--mission=')) {
      missionText = arg.slice('--mission='.length);
      continue;
    }
    if (arg === '--sandbox') {
      if (!next) throw new Error('--sandbox requires a value.');
      sandboxCommand = next;
      i++;
      continue;
    }
    if (arg.startsWith('--sandbox=')) {
      sandboxCommand = arg.slice('--sandbox='.length);
      continue;
    }
    if (arg === '--keep-policy') {
      if (!next) throw new Error('--keep-policy requires a value.');
      keepPolicy = parseAutoresearchKeepPolicy(next);
      i++;
      continue;
    }
    if (arg.startsWith('--keep-policy=')) {
      keepPolicy = parseAutoresearchKeepPolicy(arg.slice('--keep-policy='.length));
      continue;
    }
    if (arg === '--slug') {
      if (!next) throw new Error('--slug requires a value.');
      slug = slugifyMissionName(next);
      i++;
      continue;
    }
    if (arg.startsWith('--slug=')) {
      slug = slugifyMissionName(arg.slice('--slug='.length));
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(
        `Unknown autoresearch flag: ${arg.split('=')[0]}.\n`
        + 'Use --mission plus --sandbox to bypass the intake, seed with --topic/--evaluator/--slug, or provide a mission-dir.\n\n'
        + `${AUTORESEARCH_HELP}`,
      );
    }

    throw new Error(
      `Positional arguments are not supported with --mission/--sandbox bypass mode: ${arg}.\n\n${AUTORESEARCH_HELP}`,
    );
  }

  const hasMission = typeof missionText === 'string' && missionText.trim().length > 0;
  const hasSandbox = typeof sandboxCommand === 'string' && sandboxCommand.trim().length > 0;
  if (hasMission !== hasSandbox) {
    throw new Error(
      'Both --mission and --sandbox are required together to bypass the intake. '
      + 'Provide both flags, or neither to use interactive intake.\n\n'
      + `${AUTORESEARCH_HELP}`,
    );
  }
  if (!hasMission || !hasSandbox) {
    throw new Error(
      'Use --mission plus --sandbox together to bypass the intake. '
      + '--keep-policy and --slug are optional only when both are present.\n\n'
      + `${AUTORESEARCH_HELP}`,
    );
  }

  return {
    missionDir: null,
    runId: null,
    claudeArgs: [],
    missionText: missionText!.trim(),
    sandboxCommand: sandboxCommand!.trim(),
    keepPolicy,
    slug,
  };
}

function resolveRepoRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function parseAutoresearchArgs(args: readonly string[]): ParsedAutoresearchArgs {
  const values = [...args];
  if (values.length === 0) {
    return { missionDir: null, runId: null, claudeArgs: [], guided: true };
  }

  const bypass = parseAutoresearchBypassArgs(values);
  if (bypass) {
    return bypass;
  }
  const first = values[0];
  if (first === 'init') {
    return { missionDir: null, runId: null, claudeArgs: [], guided: true, initArgs: values.slice(1) };
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    return { missionDir: '--help', runId: null, claudeArgs: [] };
  }
  if (first === '--resume') {
    const runId = values[1]?.trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${AUTORESEARCH_HELP}`);
    }
    return { missionDir: null, runId, claudeArgs: values.slice(2) };
  }
  if (first.startsWith('--resume=')) {
    const runId = first.slice('--resume='.length).trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${AUTORESEARCH_HELP}`);
    }
    return { missionDir: null, runId, claudeArgs: values.slice(1) };
  }
  if (first.startsWith('-')) {
    return {
      missionDir: null,
      runId: null,
      claudeArgs: [],
      guided: true,
      seedArgs: parseInitArgs(values),
    };
  }
  return { missionDir: first, runId: null, claudeArgs: values.slice(1) };
}

async function runAutoresearchLoop(
  claudeArgs: string[],
  runtime: {
    instructionsFile: string;
    manifestFile: string;
    repoRoot: string;
    worktreePath: string;
  },
  missionDir: string,
): Promise<void> {
  const previousInstructionsFile = process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
  const originalCwd = process.cwd();
  process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;

  try {
    while (true) {
      runAutoresearchTurn(runtime.worktreePath, runtime.instructionsFile, claudeArgs);

      const contract = await loadAutoresearchMissionContract(missionDir);
      const manifest = await loadAutoresearchRunManifest(runtime.repoRoot, JSON.parse(execFileSync('cat', [runtime.manifestFile], { encoding: 'utf-8' })).run_id);
      const decision = await processAutoresearchCandidate(contract, manifest, runtime.repoRoot);
      if (decision === 'abort' || decision === 'error') {
        return;
      }
      if (decision === 'noop') {
        const trailingNoops = await countTrailingAutoresearchNoops(manifest.ledger_file);
        if (trailingNoops >= AUTORESEARCH_MAX_CONSECUTIVE_NOOPS) {
          await finalizeAutoresearchRunState(runtime.repoRoot, manifest.run_id, {
            status: 'stopped',
            stopReason: `repeated noop limit reached (${AUTORESEARCH_MAX_CONSECUTIVE_NOOPS})`,
          });
          return;
        }
      }
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;
    }
  } finally {
    process.chdir(originalCwd);
    if (typeof previousInstructionsFile === 'string') {
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = previousInstructionsFile;
    } else {
      delete process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
    }
  }
}

function planWorktree(repoRoot: string, missionSlug: string, runTag: string): { worktreePath: string; branchName: string } {
  const worktreePath = `${repoRoot}/../${repoRoot.split('/').pop()}.omc-worktrees/autoresearch-${missionSlug}-${runTag.toLowerCase()}`;
  const branchName = `autoresearch/${missionSlug}/${runTag.toLowerCase()}`;
  return { worktreePath, branchName };
}

export async function autoresearchCommand(args: string[]): Promise<void> {
  const parsed = parseAutoresearchArgs(args);
  if (parsed.missionDir === '--help') {
    console.log(AUTORESEARCH_HELP);
    return;
  }

  if (parsed.guided || parsed.missionText) {
    const repoRoot = resolveRepoRoot(process.cwd());
    let result;
    if (parsed.missionText && parsed.sandboxCommand) {
      result = await initAutoresearchMission({
        topic: parsed.missionText,
        evaluatorCommand: parsed.sandboxCommand,
        keepPolicy: parsed.keepPolicy,
        slug: parsed.slug || slugifyMissionName(parsed.missionText),
        repoRoot,
      });
    } else if (parsed.initArgs && parsed.initArgs.length > 0) {
      const initOpts = parseInitArgs(parsed.initArgs);
      if (!initOpts.topic || !initOpts.evaluatorCommand || !initOpts.slug) {
        throw new Error(
          'init requires --topic, --evaluator, and --slug flags.\n'
          + 'Optional: --keep-policy\n\n'
          + `${AUTORESEARCH_HELP}`,
        );
      }
      result = await initAutoresearchMission({
        topic: initOpts.topic,
        evaluatorCommand: initOpts.evaluatorCommand,
        keepPolicy: initOpts.keepPolicy,
        slug: initOpts.slug,
        repoRoot,
      });
    } else {
      result = await guidedAutoresearchSetup(repoRoot, parsed.seedArgs);
    }
    spawnAutoresearchTmux(result.missionDir, result.slug);
    return;
  }

  if (parsed.runId) {
    const repoRoot = resolveRepoRoot(process.cwd());
    await assertModeStartAllowed('autoresearch', repoRoot);
    const manifest = await loadAutoresearchRunManifest(repoRoot, parsed.runId);
    const runtime = await resumeAutoresearchRuntime(repoRoot, parsed.runId);
    await runAutoresearchLoop(parsed.claudeArgs, runtime, manifest.mission_dir);
    return;
  }

  const contract = await loadAutoresearchMissionContract(parsed.missionDir as string);
  await assertModeStartAllowed('autoresearch', contract.repoRoot);
  const runTag = buildAutoresearchRunTag();
  const plan = planWorktree(contract.repoRoot, contract.missionSlug, runTag);

  execFileSync('git', ['worktree', 'add', '-b', plan.branchName, plan.worktreePath, 'HEAD'], {
    cwd: contract.repoRoot,
    stdio: 'ignore',
  });

  const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, plan.worktreePath);
  const runtime = await prepareAutoresearchRuntime(worktreeContract, contract.repoRoot, plan.worktreePath, { runTag });
  await runAutoresearchLoop(parsed.claudeArgs, runtime, worktreeContract.missionDir);
}
