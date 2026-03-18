import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { createInterface } from 'readline/promises';
import { type AutoresearchKeepPolicy, parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';
import {
  buildMissionContent,
  buildSandboxContent,
  type AutoresearchDeepInterviewResult,
  type AutoresearchSeedInputs,
  isLaunchReadyEvaluatorCommand,
  writeAutoresearchDeepInterviewArtifacts,
} from './autoresearch-intake.js';
import { buildTmuxShellCommand, isTmuxAvailable, wrapWithLoginShell } from './tmux-utils.js';

export interface InitAutoresearchOptions {
  topic: string;
  evaluatorCommand: string;
  keepPolicy?: AutoresearchKeepPolicy;
  slug: string;
  repoRoot: string;
}

export interface InitAutoresearchResult {
  missionDir: string;
  slug: string;
}

export interface AutoresearchQuestionIO {
  question(prompt: string): Promise<string>;
  close(): void;
}

function createQuestionIO(): AutoresearchQuestionIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(prompt: string) {
      return rl.question(prompt);
    },
    close() {
      rl.close();
    },
  };
}

async function promptWithDefault(io: AutoresearchQuestionIO, prompt: string, currentValue?: string): Promise<string> {
  const suffix = currentValue?.trim() ? ` [${currentValue.trim()}]` : '';
  const answer = await io.question(`${prompt}${suffix}\n> `);
  return answer.trim() || currentValue?.trim() || '';
}

async function promptAction(io: AutoresearchQuestionIO, launchReady: boolean): Promise<'launch' | 'refine'> {
  const answer = (await io.question(`\nNext step [launch/refine further] (default: ${launchReady ? 'launch' : 'refine further'})\n> `)).trim().toLowerCase();
  if (!answer) {
    return launchReady ? 'launch' : 'refine';
  }
  if (answer === 'launch') {
    return 'launch';
  }
  if (answer === 'refine further' || answer === 'refine' || answer === 'r') {
    return 'refine';
  }
  throw new Error('Please choose either "launch" or "refine further".');
}

function ensureLaunchReadyEvaluator(command: string): void {
  if (!isLaunchReadyEvaluatorCommand(command)) {
    throw new Error('Evaluator command is still a placeholder/template. Refine further before launch.');
  }
}

export async function materializeAutoresearchDeepInterviewResult(
  result: AutoresearchDeepInterviewResult,
): Promise<InitAutoresearchResult> {
  ensureLaunchReadyEvaluator(result.compileTarget.evaluatorCommand);
  return initAutoresearchMission(result.compileTarget);
}

export async function initAutoresearchMission(opts: InitAutoresearchOptions): Promise<InitAutoresearchResult> {
  const missionsRoot = join(opts.repoRoot, 'missions');
  const missionDir = join(missionsRoot, opts.slug);

  const rel = relative(missionsRoot, missionDir);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid slug: resolves outside missions/ directory.');
  }

  if (existsSync(missionDir)) {
    throw new Error(`Mission directory already exists: ${missionDir}`);
  }

  await mkdir(missionDir, { recursive: true });

  const missionContent = buildMissionContent(opts.topic);
  const sandboxContent = buildSandboxContent(opts.evaluatorCommand, opts.keepPolicy);
  parseSandboxContract(sandboxContent);

  await writeFile(join(missionDir, 'mission.md'), missionContent, 'utf-8');
  await writeFile(join(missionDir, 'sandbox.md'), sandboxContent, 'utf-8');

  return { missionDir, slug: opts.slug };
}

export function parseInitArgs(args: readonly string[]): Partial<InitAutoresearchOptions> {
  const result: Partial<InitAutoresearchOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === '--topic') && next) {
      result.topic = next;
      i++;
    } else if ((arg === '--evaluator') && next) {
      result.evaluatorCommand = next;
      i++;
    } else if ((arg === '--keep-policy') && next) {
      const normalized = next.trim().toLowerCase();
      if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
        throw new Error('--keep-policy must be one of: score_improvement, pass_only');
      }
      result.keepPolicy = normalized;
      i++;
    } else if ((arg === '--slug') && next) {
      result.slug = slugifyMissionName(next);
      i++;
    } else if (arg.startsWith('--topic=')) {
      result.topic = arg.slice('--topic='.length);
    } else if (arg.startsWith('--evaluator=')) {
      result.evaluatorCommand = arg.slice('--evaluator='.length);
    } else if (arg.startsWith('--keep-policy=')) {
      const normalized = arg.slice('--keep-policy='.length).trim().toLowerCase();
      if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
        throw new Error('--keep-policy must be one of: score_improvement, pass_only');
      }
      result.keepPolicy = normalized;
    } else if (arg.startsWith('--slug=')) {
      result.slug = slugifyMissionName(arg.slice('--slug='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown init flag: ${arg.split('=')[0]}`);
    }
  }
  return result;
}

export async function runAutoresearchNoviceBridge(
  repoRoot: string,
  seedInputs: AutoresearchSeedInputs = {},
  io: AutoresearchQuestionIO = createQuestionIO(),
): Promise<InitAutoresearchResult> {
  if (!process.stdin.isTTY) {
    throw new Error('Guided setup requires an interactive terminal. Use <mission-dir> or init --topic/--evaluator/--keep-policy/--slug for non-interactive use.');
  }

  let topic = seedInputs.topic?.trim() || '';
  let evaluatorCommand = seedInputs.evaluatorCommand?.trim() || '';
  let keepPolicy: AutoresearchKeepPolicy = seedInputs.keepPolicy || 'score_improvement';
  let slug = seedInputs.slug?.trim() || '';

  try {
    while (true) {
      topic = await promptWithDefault(io, 'Research topic/goal', topic);
      if (!topic) {
        throw new Error('Research topic is required.');
      }

      const evaluatorIntent = await promptWithDefault(io, '\nHow should OMC judge success? Describe it in plain language', topic);
      evaluatorCommand = await promptWithDefault(
        io,
        '\nEvaluator command (leave placeholder to refine further; must output {pass:boolean, score?:number} JSON before launch)',
        evaluatorCommand || `TODO replace with evaluator command for: ${evaluatorIntent}`,
      );

      const keepPolicyInput = await promptWithDefault(io, '\nKeep policy [score_improvement/pass_only]', keepPolicy);
      keepPolicy = keepPolicyInput.trim().toLowerCase() === 'pass_only' ? 'pass_only' : 'score_improvement';

      slug = await promptWithDefault(io, '\nMission slug', slug || slugifyMissionName(topic));
      slug = slugifyMissionName(slug);

      const deepInterview = await writeAutoresearchDeepInterviewArtifacts({
        repoRoot,
        topic,
        evaluatorCommand,
        keepPolicy,
        slug,
        seedInputs,
      });

      console.log(`\nDraft saved: ${deepInterview.draftArtifactPath}`);
      console.log(`Launch readiness: ${deepInterview.launchReady ? 'ready' : deepInterview.blockedReasons.join(' ')}`);

      const action = await promptAction(io, deepInterview.launchReady);
      if (action === 'refine') {
        continue;
      }

      return materializeAutoresearchDeepInterviewResult(deepInterview);
    }
  } finally {
    io.close();
  }
}

export async function guidedAutoresearchSetup(
  repoRoot: string,
  seedInputs: AutoresearchSeedInputs = {},
  io: AutoresearchQuestionIO = createQuestionIO(),
): Promise<InitAutoresearchResult> {
  return runAutoresearchNoviceBridge(repoRoot, seedInputs, io);
}

export function checkTmuxAvailable(): boolean {
  return isTmuxAvailable();
}

function resolveMissionRepoRoot(missionDir: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: missionDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertTmuxSessionAvailable(sessionName: string): void {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `tmux session "${sessionName}" did not stay available after launch. `
      + 'Check the mission command, login-shell environment, and tmux logs, then try again.',
    );
  }
}

export function spawnAutoresearchTmux(missionDir: string, slug: string): void {
  if (!checkTmuxAvailable()) {
    throw new Error('tmux is required for detached background autoresearch execution. Install tmux or run `omc autoresearch <mission-dir>` directly.');
  }

  const sessionName = `omc-autoresearch-${slug}`;

  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    throw new Error(
      `tmux session "${sessionName}" already exists.\n`
      + `  Attach: tmux attach -t ${sessionName}\n`
      + `  Kill:   tmux kill-session -t ${sessionName}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists')) {
      throw error;
    }
  }

  const repoRoot = resolveMissionRepoRoot(missionDir);
  const omcPath = resolve(join(__dirname, '..', '..', 'bin', 'omc.js'));
  const command = buildTmuxShellCommand(process.execPath, [omcPath, 'autoresearch', missionDir]);
  const wrappedCommand = wrapWithLoginShell(command);

  execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', repoRoot, wrappedCommand], { stdio: 'ignore' });
  assertTmuxSessionAvailable(sessionName);

  console.log('\nAutoresearch launched in background.');
  console.log(`  Session:  ${sessionName}`);
  console.log(`  Mission:  ${missionDir}`);
  console.log(`  Attach:   tmux attach -t ${sessionName}`);
}
