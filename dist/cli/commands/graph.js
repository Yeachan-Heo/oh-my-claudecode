import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
export const GRAPH_COMMAND_OPERATIONS = [
    'create',
    'inspect',
    'approve',
    'ready',
    'claim',
    'complete',
    'fail',
    'propose-patch',
    'approve-patch',
    'status',
    'pause',
    'abandon',
    'resume',
    'resolve-join',
    'renew-claim',
    'recover-expired-claim',
    'record-late-claim-result',
    'release-attempt-for-retry',
    'resolve-reconciliation',
];
const GRAPH_INTERNAL_COMMAND_OPERATIONS = ['settle-session'];
export class GraphCommandError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GraphCommandError';
        this.code = code;
    }
}
export const GRAPH_HELP = `omc graph - Durable, human-approved orchestration graph state boundary

Usage:
  omc graph create --goal <text> --descriptor <json-or-path> --session-id <id> --driver-id <id> --transition-id <id> [--json]
  omc graph inspect --run-id <id> --session-id <id> [--json]
  omc graph approve --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --transition-id <id> --approval <json-or-path> [--json]
  omc graph ready --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> [--json]
  omc graph claim --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --driver-id <id> --transition-id <id> --limit <n> [--json]
  omc graph complete --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --claim <json-or-path> --result <json-or-path> [--identities <json-or-path>] [--json]
  omc graph fail --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --claim <json-or-path> --result <json-or-path> [--json]
  omc graph propose-patch --run-id <id> --session-id <id> --base-revision-id <id> --base-descriptor-hash <sha256> --expected-sequence <n> --transition-id <id> --patch <json-or-path> [--json]
  omc graph approve-patch --run-id <id> --session-id <id> --base-revision-id <id> --base-descriptor-hash <sha256> --expected-sequence <n> --transition-id <id> --approval <json-or-path> [--json]
  omc graph status --run-id <id> --session-id <id> [--json]
  omc graph pause --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --driver-id <id> --transition-id <id> [--json]
  omc graph abandon --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --confirmation <json-or-path> [--json]
  omc graph resume --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --driver-id <id> --transition-id <id> [--json]
  omc graph resolve-join --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --activation-id <id> --identities <json-or-path> [--json]
  omc graph renew-claim --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --lease-id <id> --driver-id <id> --tracking-id <id> --tool-still-running --now <iso8601> [--json]
  omc graph recover-expired-claim --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --lease-id <id> --now <iso8601> --new-attempt-id <id> --new-lease-id <id> --new-tracking-id <id> --driver-id <id> --reconciliation-id <id> [--json]
  omc graph record-late-claim-result --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --lease-id <id> --attempt-id <id> --recorded-at <iso8601> --summary <text> [--json]
  omc graph release-attempt-for-retry --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --activation-id <id> --attempt-id <id> [--json]
  omc graph resolve-reconciliation --run-id <id> --revision-id <id> --descriptor-hash <sha256> --session-id <id> --expected-sequence <n> --transition-id <id> --evidence <json-or-path> --resolved-at <iso8601> [--json]

JSON flags accept either an inline JSON object or a path to a JSON object.
Every operation returns one bounded JSON envelope. This command delegates state
operations to the graph runtime; it does not execute graph node work.
`;
const RUN = { flag: '--run-id', field: 'run_id', kind: 'id' };
const REVISION = { flag: '--revision-id', field: 'revision_id', kind: 'id' };
const HASH = { flag: '--descriptor-hash', field: 'descriptor_hash', kind: 'hash' };
const SEQUENCE = {
    flag: '--expected-sequence',
    field: 'expected_sequence',
    kind: 'sequence',
};
const SESSION = { flag: '--session-id', field: 'session_id', kind: 'id' };
const DRIVER = { flag: '--driver-id', field: 'driver_id', kind: 'id' };
const TRANSITION = {
    flag: '--transition-id',
    field: 'transition_id',
    kind: 'id',
};
const BASE_REVISION = {
    flag: '--base-revision-id',
    field: 'base_revision_id',
    kind: 'id',
};
const BASE_HASH = {
    flag: '--base-descriptor-hash',
    field: 'base_descriptor_hash',
    kind: 'hash',
};
const ACTIVATION = { flag: '--activation-id', field: 'activation_id', kind: 'id' };
const LEASE = { flag: '--lease-id', field: 'lease_id', kind: 'id' };
const ATTEMPT = { flag: '--attempt-id', field: 'attempt_id', kind: 'id' };
const TRACKING = { flag: '--tracking-id', field: 'tracking_id', kind: 'id' };
const RECONCILIATION = {
    flag: '--reconciliation-id',
    field: 'reconciliation_id',
    kind: 'id',
};
const OPERATION_FLAGS = {
    create: [
        { flag: '--goal', field: 'goal', kind: 'text' },
        { flag: '--descriptor', field: 'descriptor', kind: 'json' },
        SESSION,
        DRIVER,
        TRANSITION,
    ],
    inspect: [RUN, SESSION],
    approve: [
        RUN,
        REVISION,
        HASH,
        SESSION,
        TRANSITION,
        { flag: '--approval', field: 'approval', kind: 'json' },
    ],
    ready: [RUN, REVISION, HASH, SESSION, SEQUENCE],
    claim: [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        DRIVER,
        TRANSITION,
        { flag: '--limit', field: 'limit', kind: 'limit' },
    ],
    complete: [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        { flag: '--claim', field: 'claim', kind: 'json' },
        { flag: '--result', field: 'result', kind: 'json' },
        { flag: '--identities', field: 'identities', kind: 'json', optional: true },
    ],
    fail: [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        { flag: '--claim', field: 'claim', kind: 'json' },
        { flag: '--result', field: 'result', kind: 'json' },
    ],
    'propose-patch': [
        RUN,
        SESSION,
        BASE_REVISION,
        BASE_HASH,
        SEQUENCE,
        TRANSITION,
        { flag: '--patch', field: 'patch', kind: 'json' },
    ],
    'approve-patch': [
        RUN,
        SESSION,
        BASE_REVISION,
        BASE_HASH,
        SEQUENCE,
        TRANSITION,
        { flag: '--approval', field: 'approval', kind: 'json' },
    ],
    status: [RUN, SESSION],
    pause: [RUN, REVISION, HASH, SESSION, SEQUENCE, DRIVER, TRANSITION],
    abandon: [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        { flag: '--confirmation', field: 'confirmation', kind: 'json' },
    ],
    resume: [RUN, REVISION, HASH, SESSION, DRIVER, TRANSITION],
    'resolve-join': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        ACTIVATION,
        { flag: '--identities', field: 'identities', kind: 'json' },
    ],
    'renew-claim': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        LEASE,
        DRIVER,
        TRACKING,
        { flag: '--tool-still-running', field: 'tool_still_running', kind: 'boolean' },
        { flag: '--now', field: 'now', kind: 'text' },
    ],
    'recover-expired-claim': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        LEASE,
        { flag: '--now', field: 'now', kind: 'text' },
        { flag: '--new-attempt-id', field: 'new_attempt_id', kind: 'id' },
        { flag: '--new-lease-id', field: 'new_lease_id', kind: 'id' },
        { flag: '--new-tracking-id', field: 'new_tracking_id', kind: 'id' },
        DRIVER,
        RECONCILIATION,
    ],
    'record-late-claim-result': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        LEASE,
        ATTEMPT,
        { flag: '--recorded-at', field: 'recorded_at', kind: 'text' },
        { flag: '--summary', field: 'summary', kind: 'text' },
    ],
    'release-attempt-for-retry': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        ACTIVATION,
        ATTEMPT,
    ],
    'resolve-reconciliation': [
        RUN,
        REVISION,
        HASH,
        SESSION,
        SEQUENCE,
        TRANSITION,
        { flag: '--evidence', field: 'evidence', kind: 'json' },
        { flag: '--resolved-at', field: 'resolved_at', kind: 'text' },
    ],
    'settle-session': [SESSION, DRIVER, TRANSITION],
};
const MAX_JSON_INPUT_BYTES = 256 * 1024;
const MAX_JSON_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 1_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
function resolveOperation(raw) {
    return [...GRAPH_COMMAND_OPERATIONS, ...GRAPH_INTERNAL_COMMAND_OPERATIONS]
        .find((operation) => operation === raw);
}
function parseRawFlags(operation, args) {
    const definitions = OPERATION_FLAGS[operation];
    const allowed = new Set(definitions.map((definition) => definition.flag));
    const values = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === '--json')
            continue;
        const equals = token.indexOf('=');
        const flag = equals >= 0 ? token.slice(0, equals) : token;
        if (!allowed.has(flag)) {
            throw new GraphCommandError('unknown_argument', `Unknown argument for graph ${operation}: ${token}`);
        }
        if (values.has(flag)) {
            throw new GraphCommandError('duplicate_argument', `Duplicate argument for graph ${operation}: ${flag}`);
        }
        const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
        if (!value || (equals < 0 && value.startsWith('--'))) {
            throw new GraphCommandError('missing_value', `Missing value after ${flag}`);
        }
        values.set(flag, value);
        if (equals < 0)
            index += 1;
    }
    for (const definition of definitions) {
        if (!definition.optional && !values.has(definition.flag)) {
            throw new GraphCommandError('missing_argument', `Missing required ${definition.flag} for graph ${operation}`);
        }
    }
    return values;
}
async function parseJsonObject(raw, flag, cwd) {
    let source = raw.trim();
    try {
        if (!source.startsWith('{') && !source.startsWith('[')) {
            const path = resolve(cwd, source);
            const metadata = await stat(path);
            if (!metadata.isFile())
                throw new Error('path is not a regular file');
            if (metadata.size > MAX_JSON_INPUT_BYTES) {
                throw new Error(`file exceeds ${MAX_JSON_INPUT_BYTES} bytes`);
            }
            source = await readFile(path, 'utf8');
        }
        else if (Buffer.byteLength(source, 'utf8') > MAX_JSON_INPUT_BYTES) {
            throw new Error(`inline value exceeds ${MAX_JSON_INPUT_BYTES} bytes`);
        }
        const parsed = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('value must be a JSON object');
        }
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GraphCommandError('invalid_json_input', `Invalid ${flag}: ${message}`);
    }
}
function parseScalar(raw, definition) {
    const trimmed = raw.trim();
    if (definition.kind === 'id') {
        if (!ID_PATTERN.test(trimmed)) {
            throw new GraphCommandError('invalid_identifier', `Invalid ${definition.flag}`);
        }
        return trimmed;
    }
    if (definition.kind === 'hash') {
        if (!HASH_PATTERN.test(trimmed)) {
            throw new GraphCommandError('invalid_hash', `Invalid ${definition.flag}; expected lowercase SHA-256`);
        }
        return trimmed;
    }
    if (definition.kind === 'text') {
        if (!trimmed || trimmed.length > 32_768) {
            throw new GraphCommandError('invalid_text', `Invalid ${definition.flag}`);
        }
        return trimmed;
    }
    if (definition.kind === 'sequence' || definition.kind === 'limit') {
        if (!/^\d+$/.test(trimmed)) {
            throw new GraphCommandError('invalid_number', `Invalid ${definition.flag}; expected an integer`);
        }
        const value = Number(trimmed);
        const valid = definition.kind === 'sequence'
            ? Number.isSafeInteger(value) && value >= 0
            : Number.isSafeInteger(value) && value >= 1 && value <= 64;
        if (!valid)
            throw new GraphCommandError('invalid_number', `Invalid ${definition.flag}`);
        return value;
    }
    if (definition.kind === 'boolean') {
        if (trimmed !== 'true' && trimmed !== 'false') {
            throw new GraphCommandError('invalid_boolean', `Invalid ${definition.flag}; expected 'true' or 'false'`);
        }
        return trimmed === 'true';
    }
    throw new GraphCommandError('invalid_argument', `Unsupported scalar flag ${definition.flag}`);
}
async function parseRequest(operation, args, cwd) {
    const raw = parseRawFlags(operation, args);
    const input = {};
    for (const definition of OPERATION_FLAGS[operation]) {
        const value = raw.get(definition.flag);
        if (value === undefined)
            continue;
        input[definition.field] = definition.kind === 'json'
            ? await parseJsonObject(value, definition.flag, cwd)
            : parseScalar(value, definition);
    }
    return { operation, cwd, input: Object.freeze(input) };
}
async function loadDefaultService() {
    const runtimeModulePath = '../../graph/runtime.js';
    try {
        const runtime = await import(runtimeModulePath);
        if (runtime.graphCommandService?.execute)
            return runtime.graphCommandService;
    }
    catch {
        // The runtime adapter is added independently from this boundary.
    }
    throw new GraphCommandError('runtime_unavailable', 'Graph runtime adapter is unavailable; export graphCommandService from src/graph/runtime.ts');
}
function serializeBounded(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        throw new GraphCommandError('invalid_output', 'Graph service returned a non-JSON result');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_OUTPUT_BYTES) {
        throw new GraphCommandError('output_too_large', `Graph command output exceeds ${MAX_JSON_OUTPUT_BYTES} bytes`);
    }
    return serialized;
}
function boundedErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS)}...`;
}
export async function graphCommand(args, injectedService) {
    const rawOperation = args[0];
    if (!rawOperation || rawOperation === 'help' || rawOperation === '--help' || rawOperation === '-h') {
        console.log(GRAPH_HELP);
        return;
    }
    const operation = resolveOperation(rawOperation);
    if (!operation) {
        const displayedOperation = boundedErrorMessage(rawOperation);
        process.exitCode = 1;
        console.error(serializeBounded({
            ok: false,
            operation: displayedOperation,
            code: 'unknown_operation',
            error: `Unknown graph operation: ${displayedOperation}`,
        }));
        return;
    }
    try {
        const request = await parseRequest(operation, args.slice(1), process.cwd());
        const service = injectedService ?? await loadDefaultService();
        const result = await service.execute(request);
        console.log(serializeBounded({ ok: true, operation, result: result ?? null }));
    }
    catch (error) {
        process.exitCode = 1;
        const code = error instanceof GraphCommandError ? error.code : 'runtime_error';
        console.error(serializeBounded({
            ok: false,
            operation,
            code,
            error: boundedErrorMessage(error),
        }));
    }
}
//# sourceMappingURL=graph.js.map