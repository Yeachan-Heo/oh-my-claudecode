import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isStrictChildPath } from '../installer/claude-md-transaction.js';
import { executeClaudeMdTransaction } from '../installer/claude-md-transaction.js';
export const CLAUDE_MD_COORDINATOR_SCHEMA_VERSION = 1;
const COMPILED_ENGINE_VERSION = typeof __OMC_COORDINATOR_ENGINE_VERSION__ === 'string' ? __OMC_COORDINATOR_ENGINE_VERSION__ : '';
const COMPILED_SOURCE_SHA256 = typeof __OMC_COORDINATOR_SOURCE_SHA256__ === 'string' ? __OMC_COORDINATOR_SOURCE_SHA256__ : '';
export function runClaudeMdCoordinatorHandshake() {
    if (!COMPILED_ENGINE_VERSION || !COMPILED_SOURCE_SHA256) {
        return { exitCode: 2, response: coordinatorError(2, 'Coordinator build handshake is unavailable') };
    }
    return { exitCode: 0, response: { schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION, engineVersion: COMPILED_ENGINE_VERSION, sourceSha256: COMPILED_SOURCE_SHA256 } };
}
function coordinatorError(exitCode, error) { return { ok: false, exitCode, error, schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION }; }
function isObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** Refuse links in every source component, then prove the resolved target remains in the resolved plugin root. */
function verifiedSource(pluginRootInput, sourceInput) {
    const pluginRoot = resolve(pluginRootInput);
    const sourcePath = resolve(sourceInput);
    if (!isStrictChildPath(pluginRootInput, sourceInput))
        throw new Error('Source must be inside plugin root');
    if (lstatSync(pluginRoot).isSymbolicLink())
        throw new Error('Plugin root must not be a symbolic link');
    const rootReal = realpathSync(pluginRoot);
    let component = pluginRoot;
    const suffix = relative(pluginRoot, sourcePath).split(/[\\/]/);
    for (const part of suffix) {
        component = resolve(component, part);
        if (lstatSync(component).isSymbolicLink())
            throw new Error('Source path must not traverse a symbolic link');
    }
    const stat = lstatSync(sourcePath);
    if (!stat.isFile())
        throw new Error('Source must be a regular file');
    const sourceReal = realpathSync(sourcePath);
    if (!isStrictChildPath(rootReal, sourceReal))
        throw new Error('Resolved source escapes plugin root');
    return { pluginRoot, sourcePath, bytes: readFileSync(sourcePath) };
}
/** Validates the versioned stdin protocol and converts every operational failure to a JSON response. */
export function runClaudeMdCoordinator(input) {
    try {
        if (!isObject(input))
            return { exitCode: 2, response: coordinatorError(2, 'Request must be an object') };
        const allowed = new Set(['schemaVersion', 'engineVersion', 'mode', 'configRoot', 'pluginRoot', 'sourcePath', 'sourceSha256', 'sourceVersion']);
        if (Object.keys(input).some(key => !allowed.has(key)))
            return { exitCode: 2, response: coordinatorError(2, 'Unknown request field') };
        const { mode } = input;
        if (input.schemaVersion !== CLAUDE_MD_COORDINATOR_SCHEMA_VERSION || input.engineVersion !== COMPILED_ENGINE_VERSION || (mode !== 'local' && mode !== 'global-overwrite' && mode !== 'global-preserve') || typeof input.configRoot !== 'string' || typeof input.pluginRoot !== 'string' || typeof input.sourcePath !== 'string' || typeof input.sourceSha256 !== 'string' || typeof input.sourceVersion !== 'string')
            return { exitCode: 2, response: coordinatorError(2, 'Invalid coordinator request') };
        if (!COMPILED_ENGINE_VERSION || !COMPILED_SOURCE_SHA256)
            return { exitCode: 2, response: coordinatorError(2, 'Coordinator build handshake is unavailable') };
        const source = verifiedSource(input.pluginRoot, input.sourcePath);
        const sourceSha256 = createHash('sha256').update(source.bytes).digest('hex');
        if (sourceSha256 !== COMPILED_SOURCE_SHA256 || input.sourceSha256 !== COMPILED_SOURCE_SHA256 || input.sourceVersion !== COMPILED_ENGINE_VERSION)
            return { exitCode: 2, response: coordinatorError(2, 'Canonical source handshake mismatch') };
        const result = executeClaudeMdTransaction({ mode, root: input.configRoot, source: source.sourcePath, sourceRoot: source.pluginRoot, sourceBytes: source.bytes, version: input.sourceVersion });
        return { exitCode: result.exitCode, response: result };
    }
    catch (error) {
        return { exitCode: 3, response: coordinatorError(3, `Coordinator I/O validation failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
}
function main() {
    if (process.argv.slice(2).length === 1 && process.argv[2] === '--handshake') {
        const outcome = runClaudeMdCoordinatorHandshake();
        process.stdout.write(`${JSON.stringify(outcome.response)}\n`);
        process.exitCode = outcome.exitCode;
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(0)));
    }
    catch {
        process.stdout.write(`${JSON.stringify(coordinatorError(2, 'Malformed UTF-8 JSON request'))}\n`);
        process.exitCode = 2;
        return;
    }
    const outcome = runClaudeMdCoordinator(parsed);
    process.stdout.write(`${JSON.stringify(outcome.response)}\n`);
    process.exitCode = outcome.exitCode;
}
if (process.argv[1] && /claude-md-coordinator\.(?:[cm]?js|ts)$/.test(process.argv[1]))
    main();
//# sourceMappingURL=claude-md-coordinator.js.map