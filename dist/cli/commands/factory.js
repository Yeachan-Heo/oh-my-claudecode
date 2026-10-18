/**
 * Factory command (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * `omc factory listen` — the resident intake daemon. Transport adapters
 * (smee.io / cloudflared / direct) live outside the OMC boundary: the daemon
 * only receives already-unpacked webhook events as POSTs and does the OMC-side
 * work itself (HMAC verification, repo whitelist, intake label gate, routing
 * through the shared pure function, headless intent session spawn).
 *
 * `omc factory init` — seeds the project route table (`.omc/factory-routes.json`,
 * the single source of truth the SessionEnd chain enqueuer reads) and validates
 * the factory prerequisites. Default seeds the narrow starter loop; --no-narrow
 * seeds the full-pipeline widening template. Never overwrites without --force.
 *
 * Liveness: pid file at <omc root>/state/factory-listener.json (SessionStart
 * supervision reads it) plus a GET /status endpoint on the listening port.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { INTAKE_ROUTE_TABLE, startListener, stopListener } from '../../factory/listener.js';
import { readChainStatus } from '../../factory/status.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
function renderChainStatus(status) {
    const lines = [];
    lines.push(`链状态 ${status.directory}`);
    lines.push(`路由表（.omc/factory-routes.json，单一权威）: ${status.routeKeys.length} 键${status.routeKeys.length > 0 ? ` — ${status.routeKeys.join(', ')}` : ''}`);
    lines.push(`活跃 ledger: ${status.activeLedgers}`);
    lines.push(`意图（${status.intents.length}）:`);
    if (status.intents.length === 0)
        lines.push('  （无决策记录）');
    for (const intent of status.intents) {
        const last = intent.lastDecision ? `${intent.lastDecision} @ ${intent.lastDecisionAt ?? '?'}` : '无';
        const stopped = intent.stopped ? `  停链[${intent.stopped.reason}]` : '';
        lines.push(`  ${intent.intentId}  决策 ${intent.decisionCount}  末次 ${last}${stopped}`);
    }
    lines.push(`停滞环（阈值 30min 未推进）: ${status.stalled.length}`);
    for (const stall of status.stalled) {
        lines.push(`  ${stall.intentId} stage=${stall.stage} 停滞 ${Math.round(stall.stalledForMs / 60_000)}min session=${stall.session}`);
    }
    return lines.join('\n');
}
export function factoryCommand() {
    const cmd = new Command('factory');
    cmd.description('Software factory automation (chain trigger + intake listener)');
    cmd
        .command('listen')
        .description('Run the intake listener daemon: HMAC-verified webhook events -> intake label gate -> headless intent sessions')
        .option('--port <n>', 'port to listen on (transport adapters forward here)', '7788')
        .option('--host <addr>', 'host to bind to (default: 127.0.0.1 for localhost only; set to 0.0.0.0 only when transport adapter runs on another machine)', '127.0.0.1')
        .requiredOption('--repo <names>', 'repository whitelist, comma-separated owner/name')
        .option('--cwd <dir>', 'repository whose .omc state root the daemon writes to', process.cwd())
        .action((options) => {
        const secret = process.env.OMC_FACTORY_HMAC_SECRET;
        if (!secret) {
            console.error(chalk.red('refused: no HMAC secret. Set OMC_FACTORY_HMAC_SECRET.'));
            process.exitCode = 1;
            return;
        }
        const whitelist = options.repo.split(',').map((s) => s.trim()).filter(Boolean);
        if (whitelist.length === 0) {
            console.error(chalk.red('refused: --repo whitelist is empty.'));
            process.exitCode = 1;
            return;
        }
        const cwd = resolve(options.cwd);
        void startListener({ port: Number(options.port), secret, whitelist, cwd, host: options.host }).then((server) => {
            const addr = server.address();
            const port = addr && typeof addr !== 'string' ? addr.port : options.port;
            const host = addr && typeof addr !== 'string' ? addr.address : options.host;
            console.log(chalk.green(`factory listener on ${host}:${port} — whitelist: ${whitelist.join(', ')}`));
            console.log(chalk.gray(`liveness: GET http://${host === '::' ? '[::1]' : host}:${port}/status or check .omc/state/factory-listener.json`));
            const stop = () => {
                stopListener(server, cwd);
                process.exit(0);
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
        });
    });
    cmd
        .command('init')
        .description('Seed the project route table .omc/factory-routes.json (the chain-routing source of truth) and validate factory prerequisites')
        // Negatable option: Commander defaults `narrow` to true, so the default
        // seed is the narrow starter loop; --no-narrow seeds the widening template.
        .option('--no-narrow', 'seed the full-pipeline widening template (intake -> intent -> launch -> diagnose) instead of the narrow starter loop')
        .option('--cwd <dir>', 'project directory to seed (defaults to the working directory)', process.cwd())
        .option('--force', 'replace an existing route table (read it first — it is the routing source of truth)', false)
        .action((options) => {
        const result = runFactoryInit({ narrow: options.narrow, cwd: options.cwd, force: options.force });
        if (result.exitCode === 0) {
            console.log(chalk.green(result.message));
        }
        else {
            console.error(chalk.red(result.message));
            process.exitCode = result.exitCode;
        }
    });
    // Read-only audit view of this project's chain: decision trail, stop
    // markers, live ledgers, stalled links (D2). Never writes.
    cmd
        .command('status')
        .description('Summarize this project\'s chain decisions, stop markers, and stalled links (read-only)')
        .option('--json', 'Output as JSON')
        .action((options) => {
        const status = readChainStatus(process.cwd());
        if (options.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
        }
        console.log(renderChainStatus(status));
    });
    return cmd;
}
/**
 * Narrow starter route table: exactly the listener's INTAKE_ROUTE_TABLE — the
 * single intake -> intent hop. Everything after a completed intent session
 * halts (`no-route`) until the project deliberately widens the table.
 */
export function buildRouteTableNarrow() {
    return { ...INTAKE_ROUTE_TABLE };
}
/**
 * Full-pipeline widening template: a documented example widening the starter
 * loop into the intent -> launch -> diagnose progression. Keys are
 * `outcome:reason` pairs (the listener's intake label event, or the ending
 * session's outcome + hook reason); values name the next stage/skill. This is
 * a starting point to edit per project — a missing route halts the chain, and
 * `skill: "stop"` declares a terminal stage.
 */
export function buildRouteTableFull() {
    return {
        'success:intake': { stage: 'intent', skill: 'intent' },
        'success:intent': { stage: 'launch', skill: 'launch' },
        'success:launch': { stage: 'diagnose', skill: 'diagnose' },
    };
}
/**
 * Factory prerequisites, checked loudly before anything is written:
 * harbor needs the OMC state root (`.omc/state/`) and the shipyard layout
 * needs `docs/design/`.
 */
export function validateFactoryPrerequisites(cwd) {
    const missing = [];
    if (!existsSync(join(getOmcRoot(cwd), 'state')))
        missing.push('.omc/state/');
    if (!existsSync(join(cwd, 'docs', 'design')))
        missing.push('docs/design/');
    return { ok: missing.length === 0, missing };
}
/**
 * `omc factory init`: seed `.omc/factory-routes.json` — narrow starter table
 * by default, full widening template with narrow:false. Refuses loudly when
 * prerequisites are missing and never overwrites an existing table without
 * force (the SessionEnd chain enqueuer reads that file as the single source
 * of truth).
 */
export function runFactoryInit(options = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const routesPath = join(getOmcRoot(cwd), 'factory-routes.json');
    const prerequisites = validateFactoryPrerequisites(cwd);
    if (!prerequisites.ok) {
        return {
            exitCode: 1,
            message: `factory init refused: missing prerequisites (${prerequisites.missing.join(', ')}). Harbor needs .omc/state/ (run an OMC session or omc setup first); the shipyard layout needs docs/design/. Point --cwd at the project root.`,
        };
    }
    if (existsSync(routesPath) && !options.force) {
        return {
            exitCode: 1,
            message: `factory init refused: ${routesPath} already exists and the project route table is never overwritten. Read it first, then pass --force to replace it.`,
        };
    }
    const table = options.narrow === false ? buildRouteTableFull() : buildRouteTableNarrow();
    try {
        mkdirSync(join(routesPath, '..'), { recursive: true });
        writeFileSync(routesPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
    }
    catch (error) {
        return { exitCode: 1, message: `factory init failed: cannot write ${routesPath}: ${error.message}` };
    }
    const mode = options.narrow === false ? 'full-pipeline widening template' : 'narrow starter table';
    const routes = Object.entries(table).map(([key, directive]) => `${key} -> ${directive.stage}/${directive.skill}`).join('; ');
    return {
        exitCode: 0,
        message: `factory init wrote ${routesPath} (${mode}): ${routes}. The SessionEnd chain enqueuer reads this file as the single source of truth — a missing route halts the chain, and skill "stop" marks a terminal stage.`,
    };
}
//# sourceMappingURL=factory.js.map