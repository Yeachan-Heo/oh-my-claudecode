/**
 * Configuration Loader
 *
 * Handles loading and merging configuration from multiple sources:
 * - User config: ~/.config/claude-omc/config.jsonc
 * - Project config: .claude/omc.jsonc
 * - Environment variables
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { CANONICAL_TEAM_ROLES, CURSOR_EXECUTOR_TEAM_ROLES, KNOWN_AGENT_NAMES, } from "../shared/types.js";
import { getConfigDir } from "../utils/paths.js";
import { parseJsonc } from "../utils/jsonc.js";
import { getDefaultTierModels, BUILTIN_EXTERNAL_MODEL_DEFAULTS, shouldAutoForceInherit, } from "./models.js";
import { normalizeDelegationRole } from "../features/delegation-routing/types.js";
import { isDeprecatedMcpProvider } from "../features/delegation-routing/index.js";
/**
 * Default configuration.
 *
 * Model IDs are resolved from environment variables (OMC_MODEL_HIGH,
 * OMC_MODEL_MEDIUM, OMC_MODEL_LOW) with built-in fallbacks.
 * User/project config files can further override via deepMerge.
 *
 * Note: env vars for external model defaults (OMC_CODEX_DEFAULT_MODEL,
 * OMC_GEMINI_DEFAULT_MODEL) are read lazily in loadEnvConfig() to avoid
 * capturing stale values at module load time.
 */
export function buildDefaultConfig() {
    const defaultTierModels = getDefaultTierModels();
    return {
        agents: {
            omc: { model: defaultTierModels.HIGH },
            explore: { model: defaultTierModels.LOW },
            analyst: { model: defaultTierModels.HIGH },
            planner: { model: defaultTierModels.HIGH },
            architect: { model: defaultTierModels.HIGH },
            debugger: { model: defaultTierModels.MEDIUM },
            executor: { model: defaultTierModels.MEDIUM },
            verifier: { model: defaultTierModels.MEDIUM },
            securityReviewer: { model: defaultTierModels.MEDIUM },
            codeReviewer: { model: defaultTierModels.HIGH },
            testEngineer: { model: defaultTierModels.MEDIUM },
            designer: { model: defaultTierModels.MEDIUM },
            writer: { model: defaultTierModels.LOW },
            qaTester: { model: defaultTierModels.MEDIUM },
            scientist: { model: defaultTierModels.MEDIUM },
            tracer: { model: defaultTierModels.MEDIUM },
            gitMaster: { model: defaultTierModels.MEDIUM },
            codeSimplifier: { model: defaultTierModels.HIGH },
            critic: { model: defaultTierModels.HIGH },
            documentSpecialist: { model: defaultTierModels.MEDIUM },
        },
        features: {
            parallelExecution: true,
            lspTools: true, // Real LSP integration with language servers
            astTools: true, // Real AST tools using ast-grep
            continuationEnforcement: true,
            autoContextInjection: true,
        },
        mcpServers: {
            exa: { enabled: true },
            context7: { enabled: true },
        },
        companyContext: {
            onError: "warn",
        },
        permissions: {
            allowBash: true,
            allowEdit: true,
            allowWrite: true,
            maxBackgroundTasks: 5,
        },
        magicKeywords: {
            ultrawork: ["ultrawork", "ulw", "uw"],
            search: ["search", "find", "locate"],
            analyze: ["analyze", "investigate", "examine"],
            ultrathink: ["ultrathink", "think", "reason", "ponder"],
        },
        // Intelligent model routing configuration
        routing: {
            enabled: true,
            defaultTier: "MEDIUM",
            forceInherit: false,
            escalationEnabled: true,
            maxEscalations: 2,
            tierModels: { ...defaultTierModels },
            agentOverrides: {
                architect: {
                    tier: "HIGH",
                    reason: "Advisory agent requires deep reasoning",
                },
                planner: {
                    tier: "HIGH",
                    reason: "Strategic planning requires deep reasoning",
                },
                critic: {
                    tier: "HIGH",
                    reason: "Critical review requires deep reasoning",
                },
                analyst: {
                    tier: "HIGH",
                    reason: "Pre-planning analysis requires deep reasoning",
                },
                explore: { tier: "LOW", reason: "Exploration is search-focused" },
                writer: { tier: "LOW", reason: "Documentation is straightforward" },
            },
            escalationKeywords: [
                "critical",
                "production",
                "urgent",
                "security",
                "breaking",
                "architecture",
                "refactor",
                "redesign",
                "root cause",
            ],
            simplificationKeywords: [
                "find",
                "list",
                "show",
                "where",
                "search",
                "locate",
                "grep",
            ],
        },
        // External models configuration (Codex, Gemini)
        // Static defaults only — env var overrides applied in loadEnvConfig()
        externalModels: {
            defaults: {
                codexModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel,
                geminiModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel,
                antigravityModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.antigravityModel,
            },
            fallbackPolicy: {
                onModelFailure: "provider_chain",
                allowCrossProvider: false,
                crossProviderOrder: ["codex", "gemini"],
            },
        },
        // Delegation routing configuration (opt-in feature for external model routing)
        delegationRouting: {
            enabled: false,
            defaultProvider: "claude",
            roles: {},
        },
        // /team role routing (Option E — /team-scoped per-role provider & model)
        // Empty defaults: zero behavior change until user opts in.
        team: {
            ops: {},
            roleRouting: {},
        },
        autopilot: {
            execution: "solo",
        },
        planOutput: {
            directory: ".omc/plans",
            filenameTemplate: "{{name}}.md",
        },
        teleport: {
            symlinkNodeModules: true,
        },
        startupCodebaseMap: {
            enabled: true,
            maxFiles: 200,
            maxDepth: 4,
        },
        taskSizeDetection: {
            enabled: true,
            smallWordLimit: 50,
            largeWordLimit: 200,
            suppressHeavyModesForSmallTasks: true,
        },
        promptPrerequisites: {
            enabled: true,
            sectionNames: {
                memory: ["MÉMOIRE", "MEMOIRE", "MEMORY"],
                skills: ["SKILLS"],
                verifyFirst: ["VERIFY-FIRST", "VERIFY FIRST", "VERIFY_FIRST"],
                context: ["CONTEXT"],
            },
            blockingTools: ["Edit", "MultiEdit", "Write", "Agent", "Task"],
            executionKeywords: ["ralph", "ultrawork", "autopilot"],
        },
    };
}
export const DEFAULT_CONFIG = buildDefaultConfig();
/**
 * Configuration file locations
 */
export function getConfigPaths() {
    const userConfigDir = getConfigDir();
    return {
        user: join(userConfigDir, "claude-omc", "config.jsonc"),
        project: join(process.cwd(), ".claude", "omc.jsonc"),
    };
}
/**
 * Load and parse a JSONC file
 */
export function loadJsoncFile(path) {
    if (!existsSync(path)) {
        return null;
    }
    try {
        const content = readFileSync(path, "utf-8");
        const result = parseJsonc(content);
        return result;
    }
    catch (error) {
        console.error(`Error loading config from ${path}:`, error);
        return null;
    }
}
/**
 * Deep merge two objects
 */
export function deepMerge(target, source) {
    const result = { ...target };
    const mutableResult = result;
    for (const key of Object.keys(source)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype")
            continue;
        const sourceValue = source[key];
        const targetValue = mutableResult[key];
        if (sourceValue !== undefined &&
            typeof sourceValue === "object" &&
            sourceValue !== null &&
            !Array.isArray(sourceValue) &&
            typeof targetValue === "object" &&
            targetValue !== null &&
            !Array.isArray(targetValue)) {
            mutableResult[key] = deepMerge(targetValue, sourceValue);
        }
        else if (sourceValue !== undefined) {
            mutableResult[key] = sourceValue;
        }
    }
    return result;
}
/**
 * Load configuration from environment variables
 */
export function loadEnvConfig() {
    const config = {};
    // MCP API keys
    if (process.env.EXA_API_KEY) {
        config.mcpServers = {
            ...config.mcpServers,
            exa: { enabled: true, apiKey: process.env.EXA_API_KEY },
        };
    }
    // Feature flags from environment
    if (process.env.OMC_PARALLEL_EXECUTION !== undefined) {
        config.features = {
            ...config.features,
            parallelExecution: process.env.OMC_PARALLEL_EXECUTION === "true",
        };
    }
    if (process.env.OMC_LSP_TOOLS !== undefined) {
        config.features = {
            ...config.features,
            lspTools: process.env.OMC_LSP_TOOLS === "true",
        };
    }
    if (process.env.OMC_MAX_BACKGROUND_TASKS) {
        const maxTasks = parseInt(process.env.OMC_MAX_BACKGROUND_TASKS, 10);
        if (!isNaN(maxTasks)) {
            config.permissions = {
                ...config.permissions,
                maxBackgroundTasks: maxTasks,
            };
        }
    }
    // Routing configuration from environment
    if (process.env.OMC_ROUTING_ENABLED !== undefined) {
        config.routing = {
            ...config.routing,
            enabled: process.env.OMC_ROUTING_ENABLED === "true",
        };
    }
    if (process.env.OMC_ROUTING_FORCE_INHERIT !== undefined) {
        config.routing = {
            ...config.routing,
            forceInherit: process.env.OMC_ROUTING_FORCE_INHERIT === "true",
        };
    }
    if (process.env.OMC_ROUTING_DEFAULT_TIER) {
        const tier = process.env.OMC_ROUTING_DEFAULT_TIER.toUpperCase();
        if (tier === "LOW" || tier === "MEDIUM" || tier === "HIGH") {
            config.routing = {
                ...config.routing,
                defaultTier: tier,
            };
        }
    }
    // Model alias overrides from environment (issue #1211)
    const aliasKeys = ["HAIKU", "SONNET", "OPUS"];
    const modelAliases = {};
    for (const key of aliasKeys) {
        const envVal = process.env[`OMC_MODEL_ALIAS_${key}`];
        if (envVal) {
            const lower = key.toLowerCase();
            modelAliases[lower] = envVal.toLowerCase();
        }
    }
    if (Object.keys(modelAliases).length > 0) {
        config.routing = {
            ...config.routing,
            modelAliases: modelAliases,
        };
    }
    if (process.env.OMC_ESCALATION_ENABLED !== undefined) {
        config.routing = {
            ...config.routing,
            escalationEnabled: process.env.OMC_ESCALATION_ENABLED === "true",
        };
    }
    // External models configuration from environment
    const externalModelsDefaults = {};
    if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER) {
        const provider = process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER;
        if (provider === "codex" || provider === "gemini" || provider === "antigravity") {
            externalModelsDefaults.provider = provider;
        }
    }
    if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL) {
        externalModelsDefaults.codexModel =
            process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL;
    }
    else if (process.env.OMC_CODEX_DEFAULT_MODEL) {
        // Legacy fallback
        externalModelsDefaults.codexModel = process.env.OMC_CODEX_DEFAULT_MODEL;
    }
    if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL) {
        externalModelsDefaults.geminiModel =
            process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL;
    }
    else if (process.env.OMC_GEMINI_DEFAULT_MODEL) {
        // Legacy fallback
        externalModelsDefaults.geminiModel = process.env.OMC_GEMINI_DEFAULT_MODEL;
    }
    if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL) {
        externalModelsDefaults.grokModel =
            process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    }
    else if (process.env.OMC_GROK_DEFAULT_MODEL) {
        // Legacy fallback
        externalModelsDefaults.grokModel = process.env.OMC_GROK_DEFAULT_MODEL;
    }
    if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL) {
        externalModelsDefaults.antigravityModel =
            process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL;
    }
    else if (process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL) {
        // Legacy fallback
        externalModelsDefaults.antigravityModel = process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL;
    }
    const externalModelsFallback = {
        onModelFailure: "provider_chain",
    };
    if (process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY) {
        const policy = process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY;
        if (policy === "provider_chain" ||
            policy === "cross_provider" ||
            policy === "claude_only") {
            externalModelsFallback.onModelFailure = policy;
        }
    }
    // Only add externalModels if any env vars were set
    if (Object.keys(externalModelsDefaults).length > 0 ||
        externalModelsFallback.onModelFailure !== "provider_chain") {
        config.externalModels = {
            defaults: externalModelsDefaults,
            fallbackPolicy: externalModelsFallback,
        };
    }
    // Delegation routing configuration from environment
    if (process.env.OMC_DELEGATION_ROUTING_ENABLED !== undefined) {
        config.delegationRouting = {
            ...config.delegationRouting,
            enabled: process.env.OMC_DELEGATION_ROUTING_ENABLED === "true",
        };
    }
    if (process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER) {
        const provider = process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER;
        if (["claude", "codex", "gemini"].includes(provider)) {
            config.delegationRouting = {
                ...config.delegationRouting,
                defaultProvider: provider,
            };
        }
    }
    // /team role routing env override (OMC_TEAM_ROLE_OVERRIDES — single JSON var).
    // Best-effort: invalid JSON logs and is ignored (no throw on env path).
    const teamRoleOverrides = parseTeamRoleOverridesFromEnv();
    if (teamRoleOverrides) {
        config.team = {
            ...config.team,
            roleRouting: {
                ...config.team?.roleRouting,
                ...teamRoleOverrides,
            },
        };
    }
    return config;
}
/**
 * Load and merge all configuration sources
 */
function warnOnDeprecatedDelegationRouting(config) {
    const deprecatedProviders = new Set();
    const defaultProvider = config.delegationRouting?.defaultProvider;
    if (isDeprecatedMcpProvider(defaultProvider)) {
        deprecatedProviders.add(defaultProvider);
    }
    const roles = config.delegationRouting?.roles ?? {};
    for (const route of Object.values(roles)) {
        const provider = route?.provider;
        if (isDeprecatedMcpProvider(provider)) {
            deprecatedProviders.add(provider);
        }
    }
    if (deprecatedProviders.size === 0) {
        return;
    }
    console.warn("[OMC] delegationRouting to Codex/Gemini is deprecated and falls back to Claude Task. Use /team for Codex/Gemini CLI workers instead.");
}
/**
 * Validate `team.roleRouting` parsed from the merged config.
 *
 * Walks the raw parsed object (not TS types) so deepMerge escapes are caught.
 * Throws a descriptive error naming offending key + allowed values.
 */
const CANONICAL_TEAM_ROLE_SET = new Set(CANONICAL_TEAM_ROLES);
const CURSOR_EXECUTOR_TEAM_ROLE_SET = new Set(CURSOR_EXECUTOR_TEAM_ROLES);
const KNOWN_AGENT_NAME_SET = new Set(KNOWN_AGENT_NAMES);
// /team CLI workers — codex/gemini/grok/cursor here are CLI integrations, NOT the deprecated MCP delegationRouting providers.
const TEAM_ROLE_PROVIDERS = new Set(["claude", "codex", "gemini", "grok", "cursor", "antigravity"]);
const TEAM_ROLE_TIERS = new Set(["HIGH", "MEDIUM", "LOW"]);
export function validateTeamConfig(config) {
    const team = config.team;
    if (!team || typeof team !== "object")
        return;
    const ops = team.ops;
    if (ops && typeof ops === "object") {
        if (ops.defaultAgentType !== undefined) {
            if (typeof ops.defaultAgentType !== "string" ||
                !TEAM_ROLE_PROVIDERS.has(ops.defaultAgentType)) {
                throw new Error(`[OMC] team.ops.defaultAgentType: invalid value "${String(ops.defaultAgentType)}". Allowed: ${[...TEAM_ROLE_PROVIDERS].join(", ")}`);
            }
        }
        if (ops.worktreeMode !== undefined) {
            const allowed = new Set(["disabled", "off", "detached", "branch", "named"]);
            if (typeof ops.worktreeMode !== "string" || !allowed.has(ops.worktreeMode)) {
                throw new Error(`[OMC] team.ops.worktreeMode: invalid value "${String(ops.worktreeMode)}". Allowed: ${[...allowed].join(", ")}`);
            }
        }
    }
    const roleRouting = team.roleRouting;
    if (!roleRouting || typeof roleRouting !== "object")
        return;
    for (const [rawRoleKey, rawSpec] of Object.entries(roleRouting)) {
        const normalized = normalizeDelegationRole(rawRoleKey);
        if (!CANONICAL_TEAM_ROLE_SET.has(normalized)) {
            throw new Error(`[OMC] team.roleRouting: unknown role "${rawRoleKey}". Allowed roles: ${[...CANONICAL_TEAM_ROLE_SET].join(", ")}`);
        }
        if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
            throw new Error(`[OMC] team.roleRouting.${rawRoleKey}: must be an object, got ${Array.isArray(rawSpec) ? "array" : typeof rawSpec}`);
        }
        const spec = rawSpec;
        // Orchestrator entry: only `model` is allowed.
        if (normalized === "orchestrator") {
            for (const key of Object.keys(spec)) {
                if (key !== "model") {
                    throw new Error(`[OMC] team.roleRouting.orchestrator: key "${key}" is not allowed (orchestrator is pinned to claude; only "model" is configurable)`);
                }
            }
            if (spec.model !== undefined && !isValidModelValue(spec.model)) {
                throw new Error(`[OMC] team.roleRouting.orchestrator.model: must be a tier name (HIGH|MEDIUM|LOW) or model ID string, got ${typeof spec.model}`);
            }
            continue;
        }
        if (spec.provider !== undefined) {
            if (typeof spec.provider !== "string" || !TEAM_ROLE_PROVIDERS.has(spec.provider)) {
                throw new Error(`[OMC] team.roleRouting.${rawRoleKey}.provider: invalid value "${String(spec.provider)}". Allowed: ${[...TEAM_ROLE_PROVIDERS].join(", ")}`);
            }
            if (spec.provider === "cursor" && !CURSOR_EXECUTOR_TEAM_ROLE_SET.has(normalized)) {
                throw new Error(`[OMC] team.roleRouting.${rawRoleKey}.provider: cursor is only supported for executor-style roles (${[...CURSOR_EXECUTOR_TEAM_ROLE_SET].join(", ")})`);
            }
        }
        if (spec.model !== undefined && !isValidModelValue(spec.model)) {
            throw new Error(`[OMC] team.roleRouting.${rawRoleKey}.model: must be a tier name (HIGH|MEDIUM|LOW) or a non-empty model ID string`);
        }
        if (spec.agent !== undefined) {
            if (typeof spec.agent !== "string" || !KNOWN_AGENT_NAME_SET.has(spec.agent)) {
                throw new Error(`[OMC] team.roleRouting.${rawRoleKey}.agent: unknown agent "${String(spec.agent)}". Allowed: ${[...KNOWN_AGENT_NAME_SET].join(", ")}`);
            }
        }
    }
}
const AUTOPILOT_EXECUTION_BACKENDS = new Set(["team", "solo"]);
const AUTOPILOT_PLANNING_MODES = new Set(["ralplan", "direct"]);
const AUTOPILOT_TEAM_AGENT_TYPES = new Set([
    "claude",
    "codex",
    "gemini",
    "grok",
    "cursor",
    "antigravity",
]);
const AUTOPILOT_WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const AUTOPILOT_WORKFLOW_RESERVED_NAMES = new Set([
    "autopilot",
    "ralplan",
    "execution",
    "ralph",
    "qa",
    "autoresearch",
    "ultraqa",
    "merge-readiness",
    "self-improve",
    "ultrawork",
    "ultrapilot",
    "swarm",
    "pipeline",
    "plan",
    "team",
    "cancel",
    "deep-interview",
    "deepsearch",
    "ultrathink",
    "tdd",
    "code-review",
    "security-review",
    "analyze",
    "search",
    "ultragoal",
    "default",
]);
const AUTOPILOT_WORKFLOW_SEQUENCES = [
    ["ralplan", "execution"],
    ["ralplan", "execution", "ralph"],
    ["ralplan", "execution", "qa"],
    ["ralplan", "execution", "ralph", "qa"],
];
function isAutopilotWorkflowSequence(stages) {
    return AUTOPILOT_WORKFLOW_SEQUENCES.some((sequence) => stages.length === sequence.length && stages.every((stage, index) => typeof stage === "string" && stage === sequence[index]));
}
function workflowError(source, path, message) {
    throw new Error(`[OMC] ${source} ${path}: ${message}`);
}
/** Validate the closed v1 workflow block without changing legacy config validation. */
export function validateAutopilotWorkflows(config, source) {
    if (!config || typeof config !== "object" || Array.isArray(config))
        return;
    const autopilot = config.autopilot;
    if (autopilot === undefined)
        return;
    if (!autopilot || typeof autopilot !== "object" || Array.isArray(autopilot))
        return;
    const workflows = autopilot.workflows;
    if (workflows === undefined)
        return;
    if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) {
        workflowError(source, "autopilot.workflows", "must be an object map");
    }
    for (const [name, profile] of Object.entries(workflows)) {
        const path = `autopilot.workflows.${name}`;
        if (!AUTOPILOT_WORKFLOW_NAME.test(name)) {
            workflowError(source, path, "name must match ^[a-z][a-z0-9-]{0,62}$");
        }
        if (AUTOPILOT_WORKFLOW_RESERVED_NAMES.has(name)) {
            workflowError(source, path, `name "${name}" is reserved`);
        }
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            workflowError(source, path, "must be an object");
        }
        const profileRecord = profile;
        for (const key of Object.keys(profileRecord)) {
            if (key !== "version" && key !== "stages") {
                workflowError(source, `${path}.${key}`, "unknown profile key");
            }
        }
        if (profileRecord.version !== 1) {
            workflowError(source, `${path}.version`, "must be the number 1");
        }
        if (!Array.isArray(profileRecord.stages)) {
            workflowError(source, `${path}.stages`, "must be an array");
        }
        if (!isAutopilotWorkflowSequence(profileRecord.stages)) {
            workflowError(source, `${path}.stages`, "must be one of: [ralplan, execution], [ralplan, execution, ralph], [ralplan, execution, qa], [ralplan, execution, ralph, qa]");
        }
    }
}
function composeAutopilotWorkflows(config, userConfig, projectConfig) {
    const userWorkflows = userConfig?.autopilot?.workflows;
    const projectWorkflows = projectConfig?.autopilot?.workflows;
    if (userWorkflows === undefined && projectWorkflows === undefined)
        return config;
    return {
        ...config,
        autopilot: {
            ...config.autopilot,
            workflows: {
                ...userWorkflows,
                ...projectWorkflows,
            },
        },
    };
}
export function validateAutopilotConfig(config) {
    const autopilot = config.autopilot;
    if (!autopilot || typeof autopilot !== "object")
        return;
    validateAutopilotWorkflows(config, "effective");
    if (autopilot.execution !== undefined &&
        (typeof autopilot.execution !== "string" ||
            !AUTOPILOT_EXECUTION_BACKENDS.has(autopilot.execution))) {
        throw new Error(`[OMC] autopilot.execution: invalid value "${String(autopilot.execution)}". Allowed: ${[...AUTOPILOT_EXECUTION_BACKENDS].join(", ")}`);
    }
    if (autopilot.planning !== undefined &&
        autopilot.planning !== false &&
        (typeof autopilot.planning !== "string" ||
            !AUTOPILOT_PLANNING_MODES.has(autopilot.planning))) {
        throw new Error(`[OMC] autopilot.planning: invalid value "${String(autopilot.planning)}". Allowed: ralplan, direct, false`);
    }
    const team = autopilot.team;
    if (!team || typeof team !== "object")
        return;
    if (team.agentTypes !== undefined) {
        if (!Array.isArray(team.agentTypes)) {
            throw new Error("[OMC] autopilot.team.agentTypes: must be an array");
        }
        for (const agentType of team.agentTypes) {
            if (typeof agentType !== "string" ||
                !AUTOPILOT_TEAM_AGENT_TYPES.has(agentType)) {
                throw new Error(`[OMC] autopilot.team.agentTypes: invalid value "${String(agentType)}". Allowed: ${[...AUTOPILOT_TEAM_AGENT_TYPES].join(", ")}`);
            }
        }
    }
}
function isValidModelValue(value) {
    if (typeof value !== "string")
        return false;
    if (value.length === 0)
        return false;
    // Accept tier names OR explicit model IDs (any non-empty string).
    // Tier names are canonicalized during resolution; explicit IDs pass through.
    return TEAM_ROLE_TIERS.has(value) || value.length > 0;
}
function parseTeamRoleOverridesFromEnv() {
    const raw = process.env.OMC_TEAM_ROLE_OVERRIDES;
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            console.warn("[OMC] OMC_TEAM_ROLE_OVERRIDES: expected a JSON object; ignoring.");
            return undefined;
        }
        return parsed;
    }
    catch (err) {
        console.warn(`[OMC] OMC_TEAM_ROLE_OVERRIDES: invalid JSON, ignoring (${err.message})`);
        return undefined;
    }
}
export function loadConfig() {
    const paths = getConfigPaths();
    // Start with fresh defaults so env-based model overrides are resolved at call time
    let config = buildDefaultConfig();
    // Validate workflow profiles in each file before ordinary merging so a malformed
    // project replacement can never mask a malformed user profile.
    const userConfig = loadJsoncFile(paths.user);
    if (userConfig) {
        validateAutopilotWorkflows(userConfig, "user");
        config = deepMerge(config, userConfig);
    }
    const projectConfig = loadJsoncFile(paths.project);
    if (projectConfig) {
        validateAutopilotWorkflows(projectConfig, "project");
        config = deepMerge(config, projectConfig);
    }
    // Workflow profiles are atomic definitions: project replaces a same-named user
    // profile instead of deep-merging its closed fields.
    config = composeAutopilotWorkflows(config, userConfig, projectConfig);
    // Merge environment variables (highest precedence); environment has no workflow
    // profile inputs and therefore cannot define or replace profiles.
    const envConfig = loadEnvConfig();
    config = deepMerge(config, envConfig);
    // Auto-enable forceInherit for non-standard providers (issues #1201, #1025)
    // Only auto-enable if user hasn't explicitly set it via config or env var.
    // Triggers for: CC Switch / LiteLLM (non-Claude model IDs), custom
    // ANTHROPIC_BASE_URL, AWS Bedrock (CLAUDE_CODE_USE_BEDROCK=1), and
    // Google Vertex AI (CLAUDE_CODE_USE_VERTEX=1). Passing Claude-specific
    // tier names (sonnet/opus/haiku) causes 400 errors on these platforms.
    if (config.routing?.forceInherit !== true &&
        process.env.OMC_ROUTING_FORCE_INHERIT === undefined &&
        shouldAutoForceInherit()) {
        config.routing = {
            ...config.routing,
            forceInherit: true,
        };
    }
    warnOnDeprecatedDelegationRouting(config);
    // Validate /team role routing post-merge. Throws on invalid shape,
    // walking the parsed object so deepMerge bypasses surface here.
    validateTeamConfig(config);
    validateAutopilotConfig(config);
    return config;
}
const OMC_STARTUP_COMPACTABLE_SECTIONS = [
    "agent_catalog",
    "skills",
    "team_compositions",
];
const OMC_STARTUP_GUIDANCE_MAX_CHARS = 8000;
const OMC_CONTEXT_FILES_MAX_CHARS = 12000;
function compactBudgetedText(text, maxChars) {
    if (!text || maxChars <= 0)
        return "";
    const notice = "\n...[truncated to preserve startup context budget]";
    if (text.length <= maxChars)
        return text;
    if (maxChars <= notice.length)
        return notice.slice(0, maxChars);
    return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}
function looksLikeOmcGuidance(content) {
    return (content.includes("<guidance_schema_contract>") &&
        /oh-my-(claudecode|codex)/i.test(content) &&
        OMC_STARTUP_COMPACTABLE_SECTIONS.some((section) => content.includes(`<${section}>`) && content.includes(`</${section}>`)));
}
export function compactOmcStartupGuidance(content) {
    if (!looksLikeOmcGuidance(content)) {
        return content;
    }
    let compacted = content;
    let removedAny = false;
    for (const section of OMC_STARTUP_COMPACTABLE_SECTIONS) {
        const pattern = new RegExp(`\n*<${section}>[\\s\\S]*?</${section}>\n*`, "g");
        const next = compacted.replace(pattern, "\n\n");
        removedAny = removedAny || next !== compacted;
        compacted = next;
    }
    const normalized = compacted
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\n\n---\n\n---\n\n/g, "\n\n---\n\n")
        .trim();
    if (normalized.length <= OMC_STARTUP_GUIDANCE_MAX_CHARS) {
        return removedAny ? normalized : content;
    }
    const notice = "\n\n[OMC startup guidance truncated to preserve an 8000-character budget. Read the source file directly for the full document.]";
    return `${normalized.slice(0, OMC_STARTUP_GUIDANCE_MAX_CHARS - notice.length).trimEnd()}${notice}`;
}
/**
 * Find and load AGENTS.md or CLAUDE.md files for context injection
 */
export function findContextFiles(startDir) {
    const files = [];
    const searchDir = startDir ?? process.cwd();
    // Files to look for
    const contextFileNames = [
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        ".claude/AGENTS.md",
    ];
    // Search in current directory and parent directories
    let currentDir = searchDir;
    const searchedDirs = new Set();
    while (currentDir && !searchedDirs.has(currentDir)) {
        searchedDirs.add(currentDir);
        for (const fileName of contextFileNames) {
            const filePath = join(currentDir, fileName);
            if (existsSync(filePath) && !files.includes(filePath)) {
                files.push(filePath);
            }
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir)
            break;
        currentDir = parentDir;
    }
    return files;
}
/**
 * Load context from AGENTS.md/CLAUDE.md files
 */
export function loadContextFromFiles(files) {
    const contexts = [];
    let used = 0;
    const separator = "\n\n---\n\n";
    for (const file of files) {
        try {
            const content = compactOmcStartupGuidance(readFileSync(file, "utf-8"));
            const contextBlock = `## Context from ${file}\n\n${content}`;
            const separatorLength = contexts.length > 0 ? separator.length : 0;
            const remainingBudget = OMC_CONTEXT_FILES_MAX_CHARS - used - separatorLength;
            if (remainingBudget <= 0)
                break;
            if (contextBlock.length > remainingBudget) {
                contexts.push(compactBudgetedText(contextBlock, remainingBudget));
                break;
            }
            contexts.push(contextBlock);
            used += separatorLength + contextBlock.length;
        }
        catch (error) {
            console.warn(`Warning: Could not read context file ${file}:`, error);
        }
    }
    return contexts.join(separator);
}
/**
 * Generate JSON Schema for configuration (for editor autocomplete)
 */
export function generateConfigSchema() {
    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "Oh-My-ClaudeCode Configuration",
        type: "object",
        properties: {
            agents: {
                type: "object",
                description: "Agent model and feature configuration",
                properties: {
                    omc: {
                        type: "object",
                        properties: {
                            model: {
                                type: "string",
                                description: "Model ID for the main orchestrator",
                            },
                        },
                    },
                    explore: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    analyst: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    planner: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    architect: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    debugger: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    executor: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    verifier: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    securityReviewer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    codeReviewer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    testEngineer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    designer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    writer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    qaTester: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    scientist: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    tracer: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    gitMaster: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    codeSimplifier: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    critic: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                    documentSpecialist: {
                        type: "object",
                        properties: { model: { type: "string" } },
                    },
                },
            },
            features: {
                type: "object",
                description: "Feature toggles",
                properties: {
                    parallelExecution: { type: "boolean", default: true },
                    lspTools: { type: "boolean", default: true },
                    astTools: { type: "boolean", default: true },
                    continuationEnforcement: { type: "boolean", default: true },
                    autoContextInjection: { type: "boolean", default: true },
                },
            },
            mcpServers: {
                type: "object",
                description: "MCP server configurations",
                properties: {
                    exa: {
                        type: "object",
                        properties: {
                            enabled: { type: "boolean" },
                            apiKey: { type: "string" },
                        },
                    },
                    context7: {
                        type: "object",
                        properties: { enabled: { type: "boolean" } },
                    },
                },
            },
            companyContext: {
                type: "object",
                description: "Prompt-level company-context MCP contract for workflow skills",
                properties: {
                    tool: {
                        type: "string",
                        description: "Full MCP tool name to call, for example mcp__vendor__get_company_context",
                    },
                    onError: {
                        type: "string",
                        enum: ["warn", "silent", "fail"],
                        default: "warn",
                        description: "How prompt workflows should react when the configured company-context tool call fails",
                    },
                },
            },
            permissions: {
                type: "object",
                description: "Permission settings",
                properties: {
                    allowBash: { type: "boolean", default: true },
                    allowEdit: { type: "boolean", default: true },
                    allowWrite: { type: "boolean", default: true },
                    maxBackgroundTasks: {
                        type: "integer",
                        default: 5,
                        minimum: 1,
                        maximum: 50,
                    },
                },
            },
            magicKeywords: {
                type: "object",
                description: "Magic keyword triggers",
                properties: {
                    ultrawork: { type: "array", items: { type: "string" } },
                    search: { type: "array", items: { type: "string" } },
                    analyze: { type: "array", items: { type: "string" } },
                    ultrathink: { type: "array", items: { type: "string" } },
                },
            },
            teleport: {
                type: "object",
                description: "Teleport worktree bootstrap settings",
                properties: {
                    symlinkNodeModules: {
                        type: "boolean",
                        default: true,
                        description: "Symlink node_modules from the parent repo when teleport-created worktrees have a matching package.json",
                    },
                },
            },
            routing: {
                type: "object",
                description: "Intelligent model routing configuration",
                properties: {
                    enabled: {
                        type: "boolean",
                        default: true,
                        description: "Enable intelligent model routing",
                    },
                    defaultTier: {
                        type: "string",
                        enum: ["LOW", "MEDIUM", "HIGH"],
                        default: "MEDIUM",
                        description: "Default tier when no rules match",
                    },
                    forceInherit: {
                        type: "boolean",
                        default: false,
                        description: "Force all agents to inherit the parent model, bypassing OMC model routing. When true, no model parameter is passed to Task/Agent calls, so agents use the user's Claude Code model setting. Auto-enabled for non-Claude providers (CC Switch, custom ANTHROPIC_BASE_URL), AWS Bedrock, and Google Vertex AI.",
                    },
                },
            },
            externalModels: {
                type: "object",
                description: "External model provider configuration (Codex, Gemini, Grok, Antigravity)",
                properties: {
                    defaults: {
                        type: "object",
                        description: "Default model settings for external providers",
                        properties: {
                            provider: {
                                type: "string",
                                enum: ["codex", "gemini", "antigravity"],
                                description: "Default external provider",
                            },
                            codexModel: {
                                type: "string",
                                default: BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel,
                                description: "Default Codex model",
                            },
                            geminiModel: {
                                type: "string",
                                default: BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel,
                                description: "Default Gemini model",
                            },
                            grokModel: {
                                type: "string",
                                description: "Default Grok Build model",
                            },
                            antigravityModel: {
                                type: "string",
                                default: BUILTIN_EXTERNAL_MODEL_DEFAULTS.antigravityModel,
                                description: "Default Antigravity model",
                            },
                        },
                    },
                    rolePreferences: {
                        type: "object",
                        description: "Provider/model preferences by agent role",
                        additionalProperties: {
                            type: "object",
                            properties: {
                                provider: { type: "string", enum: ["codex", "gemini", "antigravity"] },
                                model: { type: "string" },
                            },
                            required: ["provider", "model"],
                        },
                    },
                    taskPreferences: {
                        type: "object",
                        description: "Provider/model preferences by task type",
                        additionalProperties: {
                            type: "object",
                            properties: {
                                provider: { type: "string", enum: ["codex", "gemini", "antigravity"] },
                                model: { type: "string" },
                            },
                            required: ["provider", "model"],
                        },
                    },
                    fallbackPolicy: {
                        type: "object",
                        description: "Fallback behavior on model failure",
                        properties: {
                            onModelFailure: {
                                type: "string",
                                enum: ["provider_chain", "cross_provider", "claude_only"],
                                default: "provider_chain",
                                description: "Fallback strategy when a model fails",
                            },
                            allowCrossProvider: {
                                type: "boolean",
                                default: false,
                                description: "Allow fallback to a different provider",
                            },
                            crossProviderOrder: {
                                type: "array",
                                items: { type: "string", enum: ["codex", "gemini", "antigravity"] },
                                default: ["codex", "gemini"],
                                description: "Order of providers for cross-provider fallback",
                            },
                        },
                    },
                },
            },
            delegationRouting: {
                type: "object",
                description: "Delegation routing configuration for external model providers (opt-in feature)",
                properties: {
                    enabled: {
                        type: "boolean",
                        default: false,
                        description: "Enable delegation routing to external providers (Codex, Gemini)",
                    },
                    defaultProvider: {
                        type: "string",
                        enum: ["claude", "codex", "gemini"],
                        default: "claude",
                        description: "Default provider for delegation routing when no specific role mapping exists",
                    },
                    roles: {
                        type: "object",
                        description: "Provider mappings by agent role",
                        additionalProperties: {
                            type: "object",
                            properties: {
                                provider: {
                                    type: "string",
                                    enum: ["claude", "codex", "gemini"],
                                },
                                tool: { type: "string", enum: ["Task"] },
                                model: { type: "string" },
                                agentType: { type: "string" },
                                fallback: { type: "array", items: { type: "string" } },
                            },
                            required: ["provider", "tool"],
                        },
                    },
                },
            },
            autopilot: {
                type: "object",
                description: "/autopilot pipeline and team execution configuration",
                properties: {
                    planning: {
                        anyOf: [
                            { type: "string", enum: ["ralplan", "direct"] },
                            { type: "boolean", enum: [false] },
                        ],
                        default: "ralplan",
                    },
                    execution: {
                        type: "string",
                        enum: ["team", "solo"],
                        default: "solo",
                    },
                    verification: {
                        anyOf: [
                            {
                                type: "object",
                                properties: {
                                    engine: { type: "string", enum: ["ralph"] },
                                    maxIterations: { type: "integer", minimum: 1 },
                                },
                                required: ["engine", "maxIterations"],
                            },
                            { type: "boolean", enum: [false] },
                        ],
                    },
                    qa: { type: "boolean", default: true },
                    workflows: {
                        type: "object",
                        description: "Named v1 autopilot stage profiles. Project profiles replace same-named user profiles.",
                        propertyNames: {
                            pattern: "^[a-z][a-z0-9-]{0,62}$",
                            not: {
                                enum: [
                                    "autopilot", "ralplan", "execution", "ralph", "qa", "autoresearch", "ultraqa",
                                    "merge-readiness", "self-improve", "ultrawork", "ultrapilot", "swarm", "pipeline",
                                    "plan", "team", "cancel", "deep-interview", "deepsearch", "ultrathink", "tdd",
                                    "code-review", "security-review", "analyze", "search",
                                ],
                            },
                        },
                        additionalProperties: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                version: { type: "integer", enum: [1] },
                                stages: {
                                    type: "array",
                                    enum: [
                                        ["ralplan", "execution"],
                                        ["ralplan", "execution", "ralph"],
                                        ["ralplan", "execution", "qa"],
                                        ["ralplan", "execution", "ralph", "qa"],
                                    ],
                                },
                            },
                            required: ["version", "stages"],
                        },
                    },
                    team: {
                        type: "object",
                        properties: {
                            agentTypes: {
                                type: "array",
                                items: {
                                    type: "string",
                                    enum: ["claude", "codex", "gemini", "grok", "cursor", "antigravity"],
                                },
                                description: "Preferred CLI worker types for executor-style autopilot team execution tasks",
                            },
                        },
                    },
                },
            },
            team: {
                type: "object",
                description: "/team runtime configuration",
                properties: {
                    ops: {
                        type: "object",
                        properties: {
                            maxAgents: { type: "integer", minimum: 1 },
                            defaultAgentType: {
                                type: "string",
                                enum: ["claude", "codex", "gemini", "grok", "cursor", "antigravity"],
                                default: "claude",
                            },
                            monitorIntervalMs: { type: "integer", minimum: 1 },
                            shutdownTimeoutMs: { type: "integer", minimum: 1 },
                            costMode: { type: "string", enum: ["normal", "downgrade"] },
                        },
                    },
                    roleRouting: {
                        type: "object",
                        description: "Provider/model overrides for canonical /team roles",
                        additionalProperties: {
                            type: "object",
                            properties: {
                                provider: { type: "string", enum: ["claude", "codex", "gemini", "grok", "cursor", "antigravity"] },
                                model: { type: "string" },
                                agent: { type: "string" },
                            },
                        },
                    },
                },
            },
        },
    };
}
//# sourceMappingURL=loader.js.map