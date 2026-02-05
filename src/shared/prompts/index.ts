/**
 * Shared prompt utilities.
 *
 * V4-agnostic prompt infrastructure used across the system.
 */

export { WORKER_PREAMBLE, wrapWithPreamble } from "./preamble.js";
export {
  validateDelegationPrompt,
  hasAllSections,
  getMissingSections,
  type ValidationResult,
} from "./delegation-validator.js";
