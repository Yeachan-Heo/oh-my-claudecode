import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { createInterface } from 'readline/promises';
import { parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';
import { AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD, buildSetupSandboxContent, } from '../autoresearch/setup-contract.js';
import { runAutoresearchSetupSession, } from './autoresearch-setup-session.js';
import { buildTmuxShellCommand, isTmuxAvailable, wrapWithLoginShell } from './tmux-utils.js';
function buildMissionContent(topic) {
    return `# Mission\n\n${topic}\n`;
}
function buildSandboxContent(evaluatorCommand, keepPolicy) {
    return buildSetupSandboxContent(evaluatorCommand, keepPolicy);
}
export async function initAutoresearchMission(opts) {
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
export function parseInitArgs(args) {
    const result = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if ((arg === '--topic') && next) {
            result.topic = next;
            i++;
        }
        else if ((arg === '--evaluator') && next) {
            result.evaluatorCommand = next;
            i++;
        }
        else if ((arg === '--keep-policy') && next) {
            const normalized = next.trim().toLowerCase();
            if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
                throw new Error('--keep-policy must be one of: score_improvement, pass_only');
            }
            result.keepPolicy = normalized;
            i++;
        }
        else if ((arg === '--slug') && next) {
            result.slug = slugifyMissionName(next);
            i++;
        }
        else if (arg.startsWith('--topic=')) {
            result.topic = arg.slice('--topic='.length);
        }
        else if (arg.startsWith('--evaluator=')) {
            result.evaluatorCommand = arg.slice('--evaluator='.length);
        }
        else if (arg.startsWith('--keep-policy=')) {
            const normalized = arg.slice('--keep-policy='.length).trim().toLowerCase();
            if (normalized !== 'pass_only' && normalized !== 'score_improvement') {
                throw new Error('--keep-policy must be one of: score_improvement, pass_only');
            }
            result.keepPolicy = normalized;
        }
        else if (arg.startsWith('--slug=')) {
            result.slug = slugifyMissionName(arg.slice('--slug='.length));
        }
        else if (arg.startsWith('--')) {
            throw new Error(`Unknown init flag: ${arg.split('=')[0]}`);
        }
    }
    return result;
}
async function askQuestion(rl, prompt) {
    return (await rl.question(prompt)).trim();
}
export async function guidedAutoresearchSetup(repoRoot, deps = {}) {
    if (!process.stdin.isTTY) {
        throw new Error('Guided setup requires an interactive terminal. Use --mission, --sandbox, --keep-policy, and --slug flags for non-interactive use.');
    }
    const makeInterface = deps.createPromptInterface ?? createInterface;
    const runSetupSession = deps.runSetupSession ?? runAutoresearchSetupSession;
    const rl = makeInterface({ input: process.stdin, output: process.stdout });
    try {
        const topic = await askQuestion(rl, 'What should autoresearch improve or prove for this repo?\n> ');
        if (!topic) {
            throw new Error('Research mission is required.');
        }
        const explicitEvaluator = await askQuestion(rl, '\nOptional evaluator command (leave blank and OMC will infer one if confidence is high)\n> ');
        const clarificationAnswers = [];
        let handoff = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            handoff = runSetupSession({
                repoRoot,
                missionText: topic,
                ...(explicitEvaluator ? { explicitEvaluatorCommand: explicitEvaluator } : {}),
                clarificationAnswers,
            });
            if (handoff.readyToLaunch) {
                break;
            }
            const question = handoff.clarificationQuestion
                ?? 'I need one more detail before launch. What should the evaluator command verify?';
            const answer = await askQuestion(rl, `\n${question}\n> `);
            if (!answer) {
                throw new Error('Autoresearch setup requires clarification before launch.');
            }
            clarificationAnswers.push(answer);
        }
        if (!handoff || !handoff.readyToLaunch) {
            throw new Error(`Autoresearch setup could not infer a launch-ready evaluator with confidence >= ${AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD}.`);
        }
        process.stdout.write(`\nSetup summary\n- mission: ${handoff.missionText}\n- evaluator: ${handoff.evaluatorCommand}\n- confidence: ${handoff.confidence}\n`);
        return initAutoresearchMission({
            topic: handoff.missionText,
            evaluatorCommand: handoff.evaluatorCommand,
            keepPolicy: handoff.keepPolicy,
            slug: handoff.slug || slugifyMissionName(handoff.missionText),
            repoRoot,
        });
    }
    finally {
        rl.close();
    }
}
export function checkTmuxAvailable() {
    return isTmuxAvailable();
}
function resolveMissionRepoRoot(missionDir) {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: missionDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function assertTmuxSessionAvailable(sessionName) {
    try {
        execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    }
    catch {
        throw new Error(`tmux session "${sessionName}" did not stay available after launch. `
            + 'Check the mission command, login-shell environment, and tmux logs, then try again.');
    }
}
export function spawnAutoresearchTmux(missionDir, slug) {
    if (!checkTmuxAvailable()) {
        throw new Error('tmux is required for background autoresearch execution. Install tmux and try again.');
    }
    const sessionName = `omc-autoresearch-${slug}`;
    try {
        execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
        throw new Error(`tmux session "${sessionName}" already exists.\n`
            + `  Attach: tmux attach -t ${sessionName}\n`
            + `  Kill:   tmux kill-session -t ${sessionName}`);
    }
    catch (error) {
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
    console.log('\nAutoresearch launched in background tmux session.');
    console.log(`  Session:  ${sessionName}`);
    console.log(`  Mission:  ${missionDir}`);
    console.log(`  Attach:   tmux attach -t ${sessionName}`);
}
export { buildAutoresearchSetupPrompt } from './autoresearch-setup-session.js';
//# sourceMappingURL=autoresearch-guided.js.map