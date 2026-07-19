export declare const CAPABILITIES_LOCK_SCHEMA_VERSION = "1.0";
export declare const DEFAULT_CAPABILITIES_LOCKFILE = "omc-capabilities.lock.json";
type FixtureKind = 'tool_selection' | 'arg_validity' | 'required_args' | 'structured_output' | 'no_hallucinated_tool' | 'tool_restraint';
type FixtureExpectedOutcome = 'pass' | 'fail';
export interface CapabilityFixture {
    id: string;
    kind: FixtureKind;
    description: string;
    expectedOutcome: FixtureExpectedOutcome;
    toolName?: string;
    args?: Record<string, unknown>;
    expectedToolName?: string;
}
export interface CapabilityFixtureResult {
    id: string;
    kind: FixtureKind;
    ok: boolean;
    outcome: FixtureExpectedOutcome;
    message: string;
}
interface CapabilityToolSurface {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
}
interface CapabilityAgentSurface {
    name: string;
    description: string;
    tools: string[] | null;
    disallowedTools: string[];
    model: string | null;
    defaultModel: string | null;
}
interface CapabilitySkillSurface {
    name: string;
    digest: string;
    title: string | null;
}
interface CapabilitySurface {
    schemaVersion: string;
    generatedBy: 'omc capabilities';
    contract: {
        runner: 'deterministic-local';
        liveProbeCompatible: true;
        fixtureKinds: FixtureKind[];
    };
    tools: CapabilityToolSurface[];
    agents: CapabilityAgentSurface[];
    skills: CapabilitySkillSurface[];
}
export interface CapabilitiesLockfile {
    schemaVersion: string;
    generatedBy: 'omc capabilities lock';
    surfaceDigest: string;
    surface: CapabilitySurface;
    fixtures: CapabilityFixture[];
    fixtureResults: CapabilityFixtureResult[];
}
interface CapabilitiesCheckFailure {
    code: string;
    message: string;
    expected?: unknown;
    actual?: unknown;
}
export interface CapabilitiesCheckReport {
    ok: boolean;
    lockfile: string;
    surfaceDigest: string;
    lockedSurfaceDigest: string;
    failures: CapabilitiesCheckFailure[];
    fixtureResults: CapabilityFixtureResult[];
}
interface CapabilityCommandOptions {
    json?: boolean;
    lockfile?: string;
}
export declare function skillNameFromSkillFilePath(skillFilePath: string): string;
export declare function collectCapabilitySurface(root?: string): CapabilitySurface;
export declare function digestCapabilitySurface(surface: CapabilitySurface): string;
export declare function defaultCapabilityFixtures(surface?: CapabilitySurface): CapabilityFixture[];
export declare function runDeterministicCapabilityFixtures(fixtures: CapabilityFixture[], surface?: CapabilitySurface): CapabilityFixtureResult[];
export declare function buildCapabilitiesLockfile(): CapabilitiesLockfile;
export declare function checkCapabilitiesLockfile(lockfilePath: string): CapabilitiesCheckReport;
export declare function capabilitiesLockCommand(options: CapabilityCommandOptions): Promise<number>;
export declare function capabilitiesCheckCommand(options: CapabilityCommandOptions): Promise<number>;
export declare function __capabilitiesTestOnly(): {
    requiredArgTool?: string;
};
export {};
//# sourceMappingURL=capabilities.d.ts.map