/**
 * Configurable quality gates for OMC workflow stages.
 *
 * Gates are configured in the merged PluginConfig `qualityGates` block. A gate
 * names a Claude Code skill, defaults to advisory mode, and may override model.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig } from "../shared/types.js";
import { loadConfig } from "./loader.js";
import { getClaudeConfigDir } from "../utils/config-dir.js";
import { getOmcRoot } from "../lib/worktree-paths.js";
import {
  getBuiltinSkillPath,
  getSkillsDir,
} from "../features/builtin-skills/skills.js";

export const QUALITY_GATE_STAGES = [
  "deep-interview",
  "ralplan",
  "omc-review",
] as const;
export type QualityGateStage = (typeof QUALITY_GATE_STAGES)[number];
export type QualityGateMode = "blocking" | "advisory";
export type QualityGateEntry = string | QualityGateObject;

export interface QualityGateObject {
  skill: string;
  mode?: QualityGateMode;
  model?: string;
}

export interface NormalizedGate {
  skill: string;
  mode: QualityGateMode;
  model?: string;
}

export type QualityGatesConfig = Partial<
  Record<QualityGateStage, QualityGateEntry[]>
>;

export interface QualityGateValidationError {
  stage: string;
  skillIndex?: number;
  entry?: string;
  error: string;
}

export interface QualityGateSkillResolutionOptions {
  cwd?: string;
  userConfigDir?: string;
  omcRoot?: string;
  bundledSkillsDir?: string;
  pluginRoot?: string | null;
}

const LEGACY_STAGE_KEYS: Record<string, QualityGateStage> = {
  "code-review": "omc-review",
  interview: "deep-interview",
  plan: "ralplan",
  codeReview: "omc-review",
};

// Retired skill names documented in docs/MIGRATION.md, src/alias-retirement,
// and the removed swarm alias note in skills/team/SKILL.md.
const RETIRED_SKILL_REPLACEMENTS: Record<string, string | null> = {
  pipeline: "execute",
  ultraqa: "verify",
  "merge-readiness": "omc-review",
  "deep-dive": "research",
  sciomc: "research",
  ccg: "ask or team",
  "omc-teams": "team",
  setup: "omc-setup",
  "mcp-setup": "Claude Code MCP configuration",
  "omc-reference": "wiki",
  learner: "remember",
  "writer-memory": "remember",
  "local-build-reminder": null,
  "understanding-gate": "omc-review",
  swarm: "team",
  "cancel-autopilot": "cancel",
  "cancel-ultrawork": "cancel",
  "cancel-ultraqa": "cancel",
  "omc-default": "omc-setup --local",
  "omc-default-global": "omc-setup --global",
  planner: "omc-plan",
};

const QUALITY_GATE_STAGE_SET = new Set<string>(QUALITY_GATE_STAGES);
const RESERVED_WORKFLOW_CONTROLLER_SKILLS = new Set<string>([
  "deep-interview",
  "ralplan",
  "omc-review",
]);

export function validateSkillName(skill: string): {
  valid: boolean;
  error?: string;
} {
  if (!skill || typeof skill !== "string") {
    return { valid: false, error: "Skill name must be a non-empty string" };
  }

  const normalized = skill.startsWith("$") ? skill.slice(1) : skill;
  if (!normalized || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return {
      valid: false,
      error: `Skill name must be kebab-case (e.g. 'design-audit'); got '${skill}'`,
    };
  }

  const replacement = RETIRED_SKILL_REPLACEMENTS[normalized];
  if (Object.hasOwn(RETIRED_SKILL_REPLACEMENTS, normalized)) {
    return {
      valid: false,
      error: replacement
        ? `Skill name '${normalized}' is retired; use '${replacement}' instead`
        : `Skill name '${normalized}' is retired with no replacement; choose a new skill name`,
    };
  }

  return { valid: true };
}

function validateQualityGateSkillName(
  skill: string,
  stage: string,
): string | undefined {
  const error = validateSkillName(skill).error;
  if (error) return error;

  const normalized = skill.startsWith("$") ? skill.slice(1) : skill;
  if (RESERVED_WORKFLOW_CONTROLLER_SKILLS.has(normalized)) {
    return `Workflow-controller skill '${normalized}' is reserved and cannot be configured as a quality gate for stage '${stage}'`;
  }
  return undefined;
}

export function normalizeGate(entry: unknown): NormalizedGate | null {
  if (typeof entry === "string") {
    return { skill: entry, mode: "advisory" };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const gate = entry as QualityGateObject;
  return {
    skill: gate.skill,
    mode: gate.mode ?? "advisory",
    ...(gate.model === undefined ? {} : { model: gate.model }),
  };
}

/** Return the raw quality-gate block from the normal merged user/project config. */
export function readQualityGatesConfig(
  config: PluginConfig = loadConfig(),
): unknown {
  return (config as PluginConfig & { qualityGates?: unknown }).qualityGates;
}

function validationError(
  stage: string,
  error: string,
  skillIndex?: number,
  entry?: unknown,
): QualityGateValidationError {
  const serializedEntry =
    entry === undefined ? undefined : (JSON.stringify(entry) ?? String(entry));
  return {
    stage,
    ...(skillIndex === undefined ? {} : { skillIndex }),
    ...(serializedEntry === undefined ? {} : { entry: serializedEntry }),
    error,
  };
}

/** Validate every configured stage and return the normalized gates for one stage. */
export function readValidatedQualityGates(
  stage: QualityGateStage,
  config: PluginConfig = loadConfig(),
): { gates: NormalizedGate[]; errors: QualityGateValidationError[] } {
  const raw = readQualityGatesConfig(config);
  if (raw === undefined) return { gates: [], errors: [] };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      gates: [],
      errors: [
        validationError(
          "qualityGates",
          "Expected an object keyed by deep-interview, ralplan, or omc-review",
        ),
      ],
    };
  }

  const gates: NormalizedGate[] = [];
  const errors: QualityGateValidationError[] = [];

  for (const [configuredStage, entries] of Object.entries(raw)) {
    const legacyStage = LEGACY_STAGE_KEYS[configuredStage];
    if (Object.hasOwn(LEGACY_STAGE_KEYS, configuredStage)) {
      errors.push(
        validationError(
          configuredStage,
          `Legacy stage key '${configuredStage}' is not accepted; use '${legacyStage}'`,
        ),
      );
      continue;
    }

    if (!QUALITY_GATE_STAGE_SET.has(configuredStage)) {
      errors.push(
        validationError(
          configuredStage,
          `Unknown quality-gate stage '${configuredStage}'; valid keys are ${QUALITY_GATE_STAGES.join(", ")}`,
        ),
      );
      continue;
    }

    if (!Array.isArray(entries)) {
      errors.push(
        validationError(
          configuredStage,
          `Expected '${configuredStage}' to be an array of gate entries`,
        ),
      );
      continue;
    }

    for (const [skillIndex, entry] of entries.entries()) {
      let error: string | undefined;
      if (typeof entry === "string") {
        error = validateQualityGateSkillName(entry, configuredStage);
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const gate = entry as Record<string, unknown>;
        if (typeof gate.skill !== "string" || gate.skill.length === 0) {
          error = 'Gate object must have a non-empty string "skill" property';
        } else if (
          gate.mode !== undefined &&
          gate.mode !== "blocking" &&
          gate.mode !== "advisory"
        ) {
          error = `Invalid mode '${String(gate.mode)}'; must be 'blocking' or 'advisory'`;
        } else if (
          gate.model !== undefined &&
          (typeof gate.model !== "string" || gate.model.length === 0)
        ) {
          error = "Gate model must be a non-empty string when specified";
        } else {
          error = validateQualityGateSkillName(gate.skill, configuredStage);
        }
      } else {
        error =
          "Gate entry must be a skill name or an object with {skill, mode?, model?}";
      }

      if (error) {
        errors.push(validationError(configuredStage, error, skillIndex, entry));
        continue;
      }

      if (configuredStage === stage) {
        const normalized = normalizeGate(entry);
        if (normalized) gates.push(normalized);
      }
    }
  }

  return { gates, errors };
}

function getSkillRoots(options: QualityGateSkillResolutionOptions): string[] {
  const cwd = options.cwd ?? process.cwd();
  const omcRoot = options.omcRoot ?? getOmcRoot(cwd);
  const userConfigDir = options.userConfigDir ?? getClaudeConfigDir();
  const bundledSkillsDir = options.bundledSkillsDir ?? getSkillsDir();
  const pluginRoot =
    options.pluginRoot === undefined
      ? process.env.CLAUDE_PLUGIN_ROOT || process.env.OMC_PLUGIN_ROOT || null
      : options.pluginRoot;

  return [
    join(cwd, ".claude", "skills"),
    join(omcRoot, "skills"),
    join(cwd, ".agents", "skills"),
    join(userConfigDir, "skills"),
    ...(pluginRoot ? [join(pluginRoot, "skills")] : []),
    bundledSkillsDir,
    join(cwd, "skills"),
  ];
}

/** Resolve a named skill using the same project/user/bundled roots as OMC skill discovery. */
export function resolveQualityGateSkillPath(
  skillName: string,
  options: QualityGateSkillResolutionOptions = {},
): string | null {
  const skill = skillName.startsWith("$") ? skillName.slice(1) : skillName;
  const roots = getSkillRoots(options);
  for (const root of roots) {
    const skillPath = join(root, skill, "SKILL.md");
    if (existsSync(skillPath)) return skillPath;
  }

  // Builtin skills may be installed under an `omc-` frontmatter name even when
  // their package directory uses the Claude-native command name (`review`, `plan`).
  if (options.bundledSkillsDir === undefined) {
    return getBuiltinSkillPath(skill) ?? null;
  }
  return null;
}

export function getGatesForStage(
  stage: QualityGateStage,
  config: PluginConfig = loadConfig(),
): NormalizedGate[] {
  return readValidatedQualityGates(stage, config).gates;
}

export function getAdvisoryGatesForStage(
  stage: QualityGateStage,
  config: PluginConfig = loadConfig(),
): NormalizedGate[] {
  return getGatesForStage(stage, config).filter(
    (gate) => gate.mode === "advisory",
  );
}

export function getBlockingGatesForStage(
  stage: QualityGateStage,
  config: PluginConfig = loadConfig(),
): NormalizedGate[] {
  return getGatesForStage(stage, config).filter(
    (gate) => gate.mode === "blocking",
  );
}
