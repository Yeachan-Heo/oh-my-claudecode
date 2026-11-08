/**
 * Configuration Module Exports
 */

export {
  loadConfig,
  loadJsoncFile,
  loadEnvConfig,
  getConfigPaths,
  deepMerge,
  findContextFiles,
  loadContextFromFiles,
  generateConfigSchema,
  DEFAULT_CONFIG,
} from "./loader.js";

export {
  DEFAULT_PLAN_OUTPUT_DIRECTORY,
  DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE,
  getPlanOutputDirectory,
  getPlanOutputFilenameTemplate,
  resolvePlanOutputFilename,
  resolvePlanOutputPath,
  resolvePlanOutputAbsolutePath,
  resolveAutopilotPlanPath,
  resolveOpenQuestionsPlanPath,
} from "./plan-output.js";

export {
  validateSkillName,
  normalizeGate,
  readQualityGatesConfig,
  readValidatedQualityGates,
  getGatesForStage,
  getAdvisoryGatesForStage,
  getBlockingGatesForStage,
  resolveQualityGateSkillPath,
  QUALITY_GATE_STAGES,
  type QualityGateStage,
  type QualityGateMode,
  type QualityGateEntry,
  type QualityGateObject,
  type NormalizedGate,
  type QualityGatesConfig,
  type QualityGateValidationError,
  type QualityGateSkillResolutionOptions,
} from "./quality-gates.js";
