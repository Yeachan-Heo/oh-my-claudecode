/**
 * Graph command - Execute sealed graph descriptors via graph runtime v2.
 *
 * Thin CLI adapter only: descriptor load/seal/resume-identity checks live
 * here; all execution logic lives in src/graph/runtime/.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseSealedGraphDescriptor, sealGraphDescriptor, } from '../graph/descriptor.js';
import { EXIT_CODES, FenceError, JournalCorruptionError, } from '../graph/runtime/types.js';
import { AgentNodeExecutor } from '../graph/runtime/executors/agent.js';
import { CommandNodeExecutor } from '../graph/runtime/executors/command.js';
import { createStdinApprovalGate } from '../graph/runtime/approval.js';
import { createRemoteApprovalGate, listPendingApprovals, writeApprovalDecision, } from '../graph/runtime/remote-approval.js';
import { createAsciiProgressReporter } from '../graph/runtime/progress.js';
import { resolveRunDirHandle } from '../graph/runtime/run-dir.js';
import { assertContainedFsSupported, readContainedFileNoFollow, readFileNoFollow, } from '../graph/runtime/safe-fs.js';
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * CLI-only exit code for unmapped runtime crashes (contract violations,
 * aborts) so they never collide with FAILED_TERMINAL (1). Not part of the
 * frozen EXIT_CODES surface.
 */
const CRASH_EXIT_CODE = 70;
function fail(message, code) {
    console.error(chalk.red(`Error: ${message}`));
    process.exitCode = code;
}
async function loadSealedDescriptor(descriptorPath, runsRoot) {
    let parsedUser;
    try {
        parsedUser = JSON.parse(readFileNoFollow(descriptorPath));
    }
    catch (error) {
        fail(`cannot read descriptor file "${descriptorPath}": ${errorMessage(error)}`, 1);
        return null;
    }
    let fresh;
    try {
        fresh = sealGraphDescriptor(parsedUser);
    }
    catch (error) {
        fail(`invalid graph descriptor "${descriptorPath}": ${errorMessage(error)}`, 1);
        return null;
    }
    // Contained run dir (P1-3): the resume probe must not follow a symlinked or
    // traversal-shaped run directory outside the runs root.
    let storedPath;
    let runDirHandle;
    try {
        runDirHandle = resolveRunDirHandle(runsRoot, fresh.run_id);
        storedPath = join(runDirHandle.path, 'descriptor.json');
    }
    catch (error) {
        fail(`invalid run directory for run "${fresh.run_id}": ${errorMessage(error)}`, 1);
        return null;
    }
    if (!existsSync(storedPath)) {
        return fresh;
    }
    let stored;
    try {
        stored = parseSealedGraphDescriptor(JSON.parse(readContainedFileNoFollow(runDirHandle, 'descriptor.json')));
    }
    catch (error) {
        fail(`stored descriptor "${storedPath}" is not a valid sealed descriptor: ${errorMessage(error)}`, 1);
        return null;
    }
    // Resume identity: the stored sealed revision must be exactly the one the
    // user asked to run, otherwise resuming would mix revisions (fail closed).
    if (canonicalJson(stored) !== canonicalJson(fresh)) {
        fail(`descriptor mismatch for run "${fresh.run_id}": ${storedPath} belongs to a different revision than "${descriptorPath}"`, EXIT_CODES.DESCRIPTOR_MISMATCH);
        return null;
    }
    return stored;
}
async function runAction(descriptorPath, runsRoot, approvalOptions = { approvalMode: 'stdin', approvalTimeoutPolicy: 'deny', checkpoint: false }) {
    try {
        // Reject unsupported POSIX before descriptor/run-directory resolution so
        // the fail-closed contract cannot create persistence state as a side
        // effect of a CLI preflight.
        assertContainedFsSupported(process.platform);
    }
    catch (error) {
        fail(`graph runtime is unavailable on ${process.platform}: ${errorMessage(error)}`, 1);
        return;
    }
    const sealed = await loadSealedDescriptor(descriptorPath, runsRoot);
    if (sealed === null)
        return;
    // Optional pre-run safety net: snapshot the working tree so a denied or
    // failed run can be rolled back. Best-effort — a checkpoint failure must
    // not block the run unless the user asked for one explicitly.
    if (approvalOptions.checkpoint) {
        try {
            const { createCheckpoint } = await import('../features/checkpoint/index.js');
            const id = createCheckpoint(process.cwd(), `before graph run ${sealed.run_id}`);
            console.log(`Checkpoint ${id} created (restore: omc checkpoint rollback ${id}).`);
        }
        catch (error) {
            fail(`--checkpoint requested but unavailable: ${errorMessage(error)}`, 1);
            return;
        }
    }
    // runGraph is imported lazily so `omc graph --help` does not load the whole
    // runtime, and so this adapter stays decoupled from runtime module order.
    const [{ runGraph }] = await Promise.all([import('../graph/runtime/runner.js')]);
    const approvalMode = approvalOptions.approvalMode ?? 'stdin';
    const timeoutPolicy = approvalOptions.approvalTimeoutPolicy ?? 'deny';
    let prompter;
    if (approvalMode === 'remote') {
        prompter = createRemoteApprovalGate({
            runsRoot,
            runId: sealed.run_id,
            ...(approvalOptions.approvalTimeout !== undefined
                ? { timeoutMs: approvalOptions.approvalTimeout * 1000 }
                : {}),
            timeoutPolicy: timeoutPolicy === 'approve' ? 'approved' : 'denied',
            notifier: async (request, record) => {
                // Lazy import keeps `omc graph --help` free of the notifications stack.
                const { notify } = await import('../notifications/index.js');
                const { resolve: resolvePath } = await import('node:path');
                await notify('approval-request', {
                    sessionId: record.run_id,
                    question: request.prompt_text,
                    message: `🔔 Approval required for graph run \`${record.run_id}\` ` +
                        `(node \`${record.node_id}\`, activation \`${record.activation_id}\`).\n\n` +
                        `${request.prompt_text}\n\n` +
                        `Reply "approved" or "denied" to decide, or run: ` +
                        `omc graph approvals decide ${record.run_id} ${record.activation_id} <approved|denied>`,
                    projectPath: process.cwd(),
                    reason: `graph approval gate: ${record.node_id}`,
                    approval: {
                        runsRoot: resolvePath(runsRoot),
                        runId: record.run_id,
                        activationId: record.activation_id,
                    },
                });
            },
        });
    }
    else {
        prompter = createStdinApprovalGate();
    }
    const options = {
        runsRoot,
        executors: [new CommandNodeExecutor(), new AgentNodeExecutor()],
        prompter,
        reporter: createAsciiProgressReporter(),
    };
    try {
        const result = await runGraph(sealed, options);
        process.exitCode = result.exit_code;
    }
    catch (error) {
        // Normative exit codes for failures the runner surfaces as thrown errors.
        if (error instanceof JournalCorruptionError) {
            fail(errorMessage(error), EXIT_CODES.CORRUPT_JOURNAL);
            return;
        }
        if (error instanceof FenceError) {
            fail(errorMessage(error), EXIT_CODES.FENCED_OUT);
            return;
        }
        fail(`[crash] ${errorMessage(error)}`, CRASH_EXIT_CODE);
    }
}
/**
 * Returns the `graph` command:
 *
 *   omc graph run <descriptorPath> [--runs-root <dir>]
 */
export function graphCommand() {
    const command = new Command('graph');
    command.description('Execute sealed graph descriptors (graph runtime v2)');
    command
        .command('run <descriptorPath>')
        .description('Run a graph descriptor with kill/resume support')
        .option('--runs-root <dir>', 'Directory holding per-run state', '.omc/graph-runs')
        .option('--approval-mode <mode>', 'Approval gate style: stdin (interactive y/n) or remote (file-backed + notification)', 'stdin')
        .option('--approval-timeout <seconds>', 'Remote approvals: max seconds to wait for a decision (default: wait forever)', (value) => Number(value))
        .option('--approval-timeout-policy <policy>', 'Remote approvals: resolution for an expired request: deny (default, fail-closed) or approve', 'deny')
        .option('--checkpoint', 'Snapshot the working tree before the run (restore with omc checkpoint rollback)', false)
        .addHelpText('after', `
Examples:
  $ omc graph run ./my-graph.json
  $ omc graph run ./my-graph.json --runs-root .omc/graph-runs
  $ omc graph run ./my-graph.json --approval-mode remote --approval-timeout 3600

Exit codes:
  0   run succeeded
  1   failed terminal
  19  fenced out by another owner
  20  corrupt journal
  21  descriptor mismatch on resume
  70  runtime crash (unmapped error)`)
        .action(async (descriptorPath, options) => {
        if (!['stdin', 'remote'].includes(options.approvalMode)) {
            fail(`invalid --approval-mode "${options.approvalMode}" (expected stdin or remote)`, 1);
            return;
        }
        if (!['deny', 'approve'].includes(options.approvalTimeoutPolicy)) {
            fail(`invalid --approval-timeout-policy "${options.approvalTimeoutPolicy}" (expected deny or approve)`, 1);
            return;
        }
        if (options.approvalTimeout !== undefined &&
            (!Number.isFinite(options.approvalTimeout) || options.approvalTimeout <= 0)) {
            fail(`invalid --approval-timeout "${options.approvalTimeout}" (expected a positive number of seconds)`, 1);
            return;
        }
        await runAction(descriptorPath, options.runsRoot, options);
    });
    const approvals = command
        .command('approvals')
        .description('List and decide pending human-approval gates for graph runs');
    approvals
        .command('list')
        .description('List pending approval requests across all runs')
        .option('--runs-root <dir>', 'Directory holding per-run state', '.omc/graph-runs')
        .action(async (options) => {
        const entries = listPendingApprovals(options.runsRoot);
        if (entries.length === 0) {
            console.log('No pending approvals.');
            return;
        }
        for (const entry of entries) {
            console.log(`${chalk.bold(entry.run_id)}  ${chalk.cyan(entry.activation_id)}  node=${entry.node_id}  created=${entry.created_at}`);
            console.log(`  ${entry.prompt_text.replace(/\n/g, '\n  ')}`);
            console.log(`  decide: omc graph approvals decide ${entry.run_id} ${entry.activation_id} <approved|denied>`);
        }
    });
    approvals
        .command('decide <runId> <activationId> <decision>')
        .description('Write an approval decision for one pending gate (approved|denied)')
        .option('--runs-root <dir>', 'Directory holding per-run state', '.omc/graph-runs')
        .option('--by <who>', 'Record who made the decision')
        .option('--rollback <checkpointId>', 'After recording a denial, roll the working tree back to a checkpoint (omc checkpoint create/list)')
        .option('--force', 'With --rollback: discard uncommitted changes made after the checkpoint', false)
        .action(async (runId, activationId, decision, options) => {
        if (decision !== 'approved' && decision !== 'denied') {
            fail(`invalid decision "${decision}" (expected approved or denied)`, 1);
            return;
        }
        try {
            const record = writeApprovalDecision(options.runsRoot, runId, activationId, decision, options.by);
            console.log(`Recorded ${chalk.bold(record.decision)} for ${chalk.cyan(activationId)} (run ${runId}).`);
        }
        catch (error) {
            fail(`cannot record decision: ${errorMessage(error)}`, 1);
            return;
        }
        if (options.rollback !== undefined) {
            if (decision === 'approved') {
                fail('--rollback applies to denied runs only; refusing to discard work on approval', 1);
                return;
            }
            try {
                const { rollbackToCheckpoint } = await import('../features/checkpoint/index.js');
                rollbackToCheckpoint(process.cwd(), options.rollback, options.force);
                console.log(`Rolled back working tree to ${chalk.bold(options.rollback)}.`);
            }
            catch (error) {
                fail(`decision recorded, but rollback failed: ${errorMessage(error)}`, 1);
            }
        }
    });
    return command;
}
//# sourceMappingURL=graph.js.map