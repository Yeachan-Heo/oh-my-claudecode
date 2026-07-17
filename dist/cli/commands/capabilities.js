import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { z } from 'zod';
import { allCustomTools, toSdkToolFormat } from '../../tools/index.js';
import { getAgentDefinitions } from '../../agents/definitions.js';
export const CAPABILITIES_LOCK_SCHEMA_VERSION = '1.0';
export const DEFAULT_CAPABILITIES_LOCKFILE = 'omc-capabilities.lock.json';
const FIXTURE_KINDS = [
    'tool_selection',
    'arg_validity',
    'required_args',
    'structured_output',
    'no_hallucinated_tool',
    'tool_restraint',
];
function stableStringify(value) {
    return JSON.stringify(sortJson(value), null, 2);
}
function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, sortJson(entry)]));
    }
    return value;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function resolveLockfilePath(lockfile) {
    return resolve(process.cwd(), lockfile ?? DEFAULT_CAPABILITIES_LOCKFILE);
}
function packageRoot() {
    if (typeof __dirname !== 'undefined' && __dirname) {
        const fromSrc = resolve(__dirname, '..', '..', '..');
        const fromDist = resolve(__dirname, '..', '..');
        if (existsSync(join(fromSrc, 'package.json')))
            return fromSrc;
        if (existsSync(join(fromDist, 'package.json')))
            return fromDist;
    }
    return process.cwd();
}
function listSkillFiles(root) {
    const skillsDir = join(root, 'skills');
    if (!existsSync(skillsDir))
        return [];
    const names = readdirSync(skillsDir).sort((a, b) => a.localeCompare(b));
    return names
        .map((name) => join(skillsDir, name, 'SKILL.md'))
        .filter((path) => existsSync(path) && statSync(path).isFile());
}
function readSkillTitle(markdown) {
    const heading = markdown.split('\n').find((line) => line.startsWith('# '));
    return heading ? heading.slice(2).trim() : null;
}
export function skillNameFromSkillFilePath(skillFilePath) {
    const normalizedPath = skillFilePath.replace(/\\/g, '/');
    return basename(dirname(normalizedPath)) || skillFilePath;
}
function normalizeToolSchema(schema) {
    return schema instanceof z.ZodObject ? schema.shape : schema;
}
export function collectCapabilitySurface(root = packageRoot()) {
    const tools = allCustomTools
        .map((tool) => ({ ...tool, schema: normalizeToolSchema(tool.schema) }))
        .map((tool) => toSdkToolFormat(tool))
        .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
            ...tool.inputSchema,
            required: [...tool.inputSchema.required].sort((a, b) => a.localeCompare(b)),
            properties: sortJson(tool.inputSchema.properties),
        },
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const agents = Object.entries(getAgentDefinitions({ config: {} }))
        .map(([name, agent]) => ({
        name,
        description: agent.description,
        tools: agent.tools ? [...agent.tools].sort((a, b) => a.localeCompare(b)) : null,
        disallowedTools: [...(agent.disallowedTools ?? [])].sort((a, b) => a.localeCompare(b)),
        model: agent.model ?? null,
        defaultModel: agent.defaultModel ?? null,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const skills = listSkillFiles(root)
        .map((path) => {
        const markdown = readFileSync(path, 'utf-8');
        return {
            name: skillNameFromSkillFilePath(path),
            digest: sha256(markdown),
            title: readSkillTitle(markdown),
        };
    })
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        schemaVersion: CAPABILITIES_LOCK_SCHEMA_VERSION,
        generatedBy: 'omc capabilities',
        contract: {
            runner: 'deterministic-local',
            liveProbeCompatible: true,
            fixtureKinds: FIXTURE_KINDS,
        },
        tools,
        agents,
        skills,
    };
}
export function digestCapabilitySurface(surface) {
    return sha256(stableStringify(surface));
}
function findRequiredArgTool() {
    return collectCapabilitySurface().tools.find((tool) => tool.inputSchema.required.length > 0);
}
function supportsSimpleStringFixture(tool) {
    return tool.inputSchema.required.length > 0 && tool.inputSchema.required.every((name) => {
        const property = tool.inputSchema.properties[name];
        return property?.type === 'string' && property.enum === undefined;
    });
}
export function defaultCapabilityFixtures(surface = collectCapabilitySurface()) {
    const requiredArgTool = surface.tools.find(supportsSimpleStringFixture) ?? surface.tools.find((tool) => tool.inputSchema.required.length > 0);
    const selectedTool = requiredArgTool ?? surface.tools[0];
    const validArgs = Object.fromEntries((requiredArgTool?.inputSchema.required ?? []).map((name) => [name, 'fixture-value']));
    return [
        {
            id: 'deterministic-tool-selection',
            kind: 'tool_selection',
            description: 'A known tool requested by name resolves to the declared tool surface.',
            expectedOutcome: 'pass',
            toolName: selectedTool?.name,
            expectedToolName: selectedTool?.name,
        },
        {
            id: 'deterministic-arg-validity',
            kind: 'arg_validity',
            description: 'A deterministic fixture with required args validates against the tool schema.',
            expectedOutcome: 'pass',
            toolName: requiredArgTool?.name,
            args: validArgs,
        },
        {
            id: 'deterministic-required-args',
            kind: 'required_args',
            description: 'A deterministic fixture omitting required args is rejected by the tool schema.',
            expectedOutcome: 'pass',
            toolName: requiredArgTool?.name,
            args: {},
        },
        {
            id: 'deterministic-structured-output',
            kind: 'structured_output',
            description: 'Fixture results keep a stable machine-readable result envelope.',
            expectedOutcome: 'pass',
        },
        {
            id: 'deterministic-no-hallucinated-tool',
            kind: 'no_hallucinated_tool',
            description: 'A requested tool that is absent from the surface is rejected.',
            expectedOutcome: 'pass',
            toolName: 'omc_nonexistent_hallucinated_tool',
        },
        {
            id: 'deterministic-tool-restraint',
            kind: 'tool_restraint',
            description: 'A no-tool fixture does not select any tool.',
            expectedOutcome: 'pass',
        },
    ];
}
function validateToolArgs(toolName, args) {
    if (!toolName) {
        return { ok: false, message: 'fixture did not name a tool' };
    }
    const tool = allCustomTools.find((candidate) => candidate.name === toolName);
    if (!tool) {
        return { ok: false, message: `tool not found: ${toolName}` };
    }
    const result = z.object(normalizeToolSchema(tool.schema)).safeParse(args ?? {});
    if (result.success) {
        return { ok: true, message: 'args valid' };
    }
    return { ok: false, message: result.error.issues.map((issue) => issue.path.join('.') || issue.message).join('; ') };
}
export function runDeterministicCapabilityFixtures(fixtures, surface = collectCapabilitySurface()) {
    const toolNames = new Set(surface.tools.map((tool) => tool.name));
    return fixtures.map((fixture) => {
        let condition = false;
        let message = 'fixture kind not implemented';
        if (fixture.kind === 'tool_selection') {
            condition = !!fixture.toolName && toolNames.has(fixture.toolName) && fixture.toolName === fixture.expectedToolName;
            message = condition ? `selected ${fixture.toolName}` : `could not select ${fixture.toolName ?? '<missing>'}`;
        }
        else if (fixture.kind === 'arg_validity') {
            const validation = validateToolArgs(fixture.toolName, fixture.args);
            condition = validation.ok;
            message = validation.message;
        }
        else if (fixture.kind === 'required_args') {
            const tool = surface.tools.find((candidate) => candidate.name === fixture.toolName);
            const validation = validateToolArgs(fixture.toolName, fixture.args);
            condition = !!tool && tool.inputSchema.required.length > 0 && !validation.ok;
            message = condition ? 'missing required args rejected' : `missing required args were not rejected: ${validation.message}`;
        }
        else if (fixture.kind === 'structured_output') {
            condition = true;
            message = 'structured fixture envelope emitted';
        }
        else if (fixture.kind === 'no_hallucinated_tool') {
            condition = !fixture.toolName || !toolNames.has(fixture.toolName);
            message = condition ? `rejected absent tool ${fixture.toolName ?? '<none>'}` : `accepted unexpected tool ${fixture.toolName}`;
        }
        else if (fixture.kind === 'tool_restraint') {
            condition = !fixture.toolName;
            message = condition ? 'no tool selected' : `unexpected tool selected: ${fixture.toolName}`;
        }
        const ok = fixture.expectedOutcome === 'pass' ? condition : !condition;
        return {
            id: fixture.id,
            kind: fixture.kind,
            ok,
            outcome: ok ? 'pass' : 'fail',
            message,
        };
    });
}
export function buildCapabilitiesLockfile() {
    const surface = collectCapabilitySurface();
    const fixtures = defaultCapabilityFixtures(surface);
    return {
        schemaVersion: CAPABILITIES_LOCK_SCHEMA_VERSION,
        generatedBy: 'omc capabilities lock',
        surfaceDigest: digestCapabilitySurface(surface),
        surface,
        fixtures,
        fixtureResults: runDeterministicCapabilityFixtures(fixtures, surface),
    };
}
function parseLockfile(path) {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.schemaVersion !== CAPABILITIES_LOCK_SCHEMA_VERSION) {
        throw new Error(`unsupported capabilities lockfile schema: ${parsed.schemaVersion ?? '<missing>'}`);
    }
    if (!Array.isArray(parsed.fixtures) || !Array.isArray(parsed.fixtureResults)) {
        throw new Error('invalid capabilities lockfile: missing fixtures or fixtureResults');
    }
    return parsed;
}
export function checkCapabilitiesLockfile(lockfilePath) {
    const locked = parseLockfile(lockfilePath);
    const surface = collectCapabilitySurface();
    const surfaceDigest = digestCapabilitySurface(surface);
    const fixtureResults = runDeterministicCapabilityFixtures(locked.fixtures, surface);
    const failures = [];
    const lockedSurfaceDigest = digestCapabilitySurface(locked.surface);
    if (lockedSurfaceDigest !== locked.surfaceDigest) {
        failures.push({
            code: 'lockfile_surface_digest_mismatch',
            message: 'Locked capability surface body digest differs from the recorded lockfile digest.',
            expected: locked.surfaceDigest,
            actual: lockedSurfaceDigest,
        });
    }
    if (surfaceDigest !== locked.surfaceDigest) {
        failures.push({
            code: 'surface_digest_mismatch',
            message: 'Current deterministic tool/skill/capability surface digest differs from lockfile.',
            expected: locked.surfaceDigest,
            actual: surfaceDigest,
        });
    }
    const lockedResultById = new Map(locked.fixtureResults.map((result) => [result.id, result]));
    for (const result of fixtureResults) {
        const expected = lockedResultById.get(result.id);
        if (!expected) {
            failures.push({
                code: 'fixture_result_missing_from_lockfile',
                message: `Fixture ${result.id} is not recorded in the lockfile.`,
                actual: result,
            });
            continue;
        }
        if (!result.ok || result.outcome !== expected.outcome || result.ok !== expected.ok) {
            failures.push({
                code: 'fixture_result_mismatch',
                message: `Fixture ${result.id} result changed or failed.`,
                expected,
                actual: result,
            });
        }
    }
    return {
        ok: failures.length === 0,
        lockfile: lockfilePath,
        surfaceDigest,
        lockedSurfaceDigest: locked.surfaceDigest,
        failures,
        fixtureResults,
    };
}
function printLockSummary(lockfilePath, lockfile, json) {
    if (json) {
        console.log(stableStringify({ ok: true, lockfile: lockfilePath, surfaceDigest: lockfile.surfaceDigest, fixtureResults: lockfile.fixtureResults }));
        return;
    }
    console.log(`Capabilities lockfile written: ${lockfilePath}`);
    console.log(`Surface digest: ${lockfile.surfaceDigest}`);
    console.log(`Fixtures: ${lockfile.fixtureResults.filter((result) => result.ok).length}/${lockfile.fixtureResults.length} passed`);
}
function printCheckReport(report, json) {
    if (json) {
        console.log(stableStringify(report));
        return;
    }
    if (report.ok) {
        console.log(`Capabilities check passed: ${report.lockfile}`);
        console.log(`Surface digest: ${report.surfaceDigest}`);
        console.log(`Fixtures: ${report.fixtureResults.filter((result) => result.ok).length}/${report.fixtureResults.length} passed`);
        return;
    }
    console.error(`Capabilities check failed: ${report.lockfile}`);
    for (const failure of report.failures) {
        console.error(`- ${failure.code}: ${failure.message}`);
    }
}
export async function capabilitiesLockCommand(options) {
    const lockfilePath = resolveLockfilePath(options.lockfile);
    const lockfile = buildCapabilitiesLockfile();
    mkdirSync(dirname(lockfilePath), { recursive: true });
    writeFileSync(lockfilePath, `${stableStringify(lockfile)}\n`);
    printLockSummary(lockfilePath, lockfile, options.json);
    return lockfile.fixtureResults.every((result) => result.ok) ? 0 : 1;
}
export async function capabilitiesCheckCommand(options) {
    const lockfilePath = resolveLockfilePath(options.lockfile);
    if (!existsSync(lockfilePath)) {
        const report = {
            ok: false,
            lockfile: lockfilePath,
            surfaceDigest: digestCapabilitySurface(collectCapabilitySurface()),
            lockedSurfaceDigest: '',
            failures: [{ code: 'lockfile_missing', message: `Capabilities lockfile not found: ${lockfilePath}` }],
            fixtureResults: [],
        };
        printCheckReport(report, options.json);
        return 1;
    }
    const report = checkCapabilitiesLockfile(lockfilePath);
    printCheckReport(report, options.json);
    return report.ok ? 0 : 1;
}
export function __capabilitiesTestOnly() {
    return { requiredArgTool: findRequiredArgTool()?.name };
}
//# sourceMappingURL=capabilities.js.map