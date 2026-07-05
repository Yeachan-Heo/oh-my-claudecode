import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline/promises';
import { parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';
import { AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD, } from '../autoresearch/setup-contract.js';
import { buildMissionContent, buildSandboxContent, isLaunchReadyEvaluatorCommand, writeAutoresearchDeepInterviewArtifacts, } from './autoresearch-intake.js';
import { runAutoresearchSetupSession, } from './autoresearch-setup-session.js';
import { buildTmuxShellCommand, isTmuxAvailable, quoteShellArg, tmuxExec, wrapWithLoginShell } from './tmux-utils.js';
const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';
const AUTORESEARCH_SETUP_SLASH_COMMAND = '/deep-interview --autoresearch';
function createQuestionIO() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
        question(prompt) {
            return rl.question(prompt);
        },
        close() {
            rl.close();
        },
    };
}
async function askQuestion(rl, prompt) {
    return (await rl.question(prompt)).trim();
}
async function promptWithDefault(io, prompt, currentValue) {
    const suffix = currentValue?.trim() ? ` [${currentValue.trim()}]` : '';
    const answer = await io.question(`${prompt}${suffix}\n> `);
    return answer.trim() || currentValue?.trim() || '';
}
async function promptAction(io, launchReady) {
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
function ensureLaunchReadyEvaluator(command) {
    if (!isLaunchReadyEvaluatorCommand(command)) {
        throw new Error('Evaluator command is still a placeholder/template. Refine further before launch.');
    }
}
export async function materializeAutoresearchDeepInterviewResult(result) {
    ensureLaunchReadyEvaluator(result.compileTarget.evaluatorCommand);
    return initAutoresearchMission(result.compileTarget);
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
        else if ((arg === '--evaluator' || arg === '--eval') && next) {
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
        else if (arg.startsWith('--evaluator=') || arg.startsWith('--eval=')) {
            result.evaluatorCommand = arg.startsWith('--evaluator=')
                ? arg.slice('--evaluator='.length)
                : arg.slice('--eval='.length);
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
export async function runAutoresearchNoviceBridge(repoRoot, seedInputs = {}, io = createQuestionIO()) {
    if (!process.stdin.isTTY) {
        throw new Error('Guided setup requires an interactive terminal. Use <mission-dir> or init --topic/--evaluator/--keep-policy/--slug for non-interactive use.');
    }
    let topic = seedInputs.topic?.trim() || '';
    let evaluatorCommand = seedInputs.evaluatorCommand?.trim() || '';
    let keepPolicy = seedInputs.keepPolicy || 'score_improvement';
    let slug = seedInputs.slug?.trim() || '';
    try {
        while (true) {
            topic = await promptWithDefault(io, 'Research topic/goal', topic);
            if (!topic) {
                throw new Error('Research topic is required.');
            }
            const evaluatorIntent = await promptWithDefault(io, '\nHow should OMC judge success? Describe it in plain language', topic);
            evaluatorCommand = await promptWithDefault(io, '\nEvaluator command (leave placeholder to refine further; must output {pass:boolean, score?:number} JSON before launch)', evaluatorCommand || `TODO replace with evaluator command for: ${evaluatorIntent}`);
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
    }
    finally {
        io.close();
    }
}
export async function guidedAutoresearchSetup(repoRoot, seedInputs = {}, io = createQuestionIO()) {
    return runAutoresearchNoviceBridge(repoRoot, seedInputs, io);
}
export async function guidedAutoresearchSetupInference(repoRoot, deps = {}) {
    if (!process.stdin.isTTY) {
        throw new Error('Guided setup requires an interactive terminal. Use --mission, --eval/--sandbox, --keep-policy, and --slug flags for non-interactive use.');
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
// Strip TMUX from the environment so tmux commands always target the default
// server. Without this, autoresearch launched from inside a nested tmux session
// (e.g. wtx/Worktrunk worktrees) silently creates sessions on the nested
// server, making them unreachable from the outer session.
function tmuxEnv() {
    const { TMUX: _, ...env } = process.env;
    return env;
}
function assertTmuxSessionAvailable(sessionName) {
    try {
        tmuxExec(['has-session', '-t', sessionName], { stripTmux: true, stdio: 'ignore' });
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
        tmuxExec(['has-session', '-t', sessionName], { stripTmux: true, stdio: 'ignore' });
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
    tmuxExec(['new-session', '-d', '-s', sessionName, '-c', repoRoot, wrappedCommand], { stripTmux: true, stdio: 'ignore' });
    assertTmuxSessionAvailable(sessionName);
    console.log('\nAutoresearch launched in background tmux session.');
    console.log(`  Session:  ${sessionName}`);
    console.log(`  Mission:  ${missionDir}`);
    console.log(`  Attach:   tmux attach -t ${sessionName}`);
}
function ensureSymlink(target, linkPath) {
    try {
        const existing = lstatSync(linkPath);
        if (existing.isSymbolicLink()) {
            return;
        }
        unlinkSync(linkPath);
    }
    catch {
        // missing path is fine
    }
    symlinkSync(target, linkPath, 'dir');
}
export function prepareAutoresearchSetupCodexHome(repoRoot, sessionName) {
    const baseCodexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const tempCodexHome = join(repoRoot, '.omx', 'tmp', sessionName, 'codex-home');
    mkdirSync(tempCodexHome, { recursive: true });
    for (const dirName of ['skills', 'commands']) {
        const sourceDir = join(baseCodexHome, dirName);
        if (existsSync(sourceDir)) {
            ensureSymlink(sourceDir, join(tempCodexHome, dirName));
        }
    }
    writeFileSync(join(tempCodexHome, '.omx-config.json'), `${JSON.stringify({ autoNudge: { enabled: false } }, null, 2)}\n`, 'utf-8');
    return tempCodexHome;
}
export function buildAutoresearchSetupSlashCommand() {
    return AUTORESEARCH_SETUP_SLASH_COMMAND;
}
export function spawnAutoresearchSetupTmux(repoRoot) {
    if (!checkTmuxAvailable()) {
        throw new Error('tmux is required for autoresearch setup. Install tmux and try again.');
    }
    const sessionName = `omc-autoresearch-setup-${Date.now().toString(36)}`;
    const codexHome = prepareAutoresearchSetupCodexHome(repoRoot, sessionName);
    const claudeCommand = buildTmuxShellCommand('env', [`CODEX_HOME=${codexHome}`, 'claude', CLAUDE_BYPASS_FLAG]);
    const wrappedClaudeCommand = wrapWithLoginShell(claudeCommand);
    const paneId = tmuxExec(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', sessionName, '-c', repoRoot, wrappedClaudeCommand], { stripTmux: true }).trim();
    assertTmuxSessionAvailable(sessionName);
    if (paneId) {
        tmuxExec(['send-keys', '-t', paneId, '-l', buildAutoresearchSetupSlashCommand()], { stripTmux: true, stdio: 'ignore' });
        tmuxExec(['send-keys', '-t', paneId, 'Enter'], { stripTmux: true, stdio: 'ignore' });
    }
    console.log('\nAutoresearch setup launched in background Claude session.');
    console.log(`  Session:  ${sessionName}`);
    console.log(`  Starter:  ${buildAutoresearchSetupSlashCommand()}`);
    console.log(`  CODEX_HOME: ${quoteShellArg(codexHome)}`);
    console.log(`  Attach:   tmux attach -t ${sessionName}`);
}
export { buildAutoresearchSetupPrompt } from './autoresearch-setup-session.js';
//# sourceMappingURL=autoresearch-guided.js.map