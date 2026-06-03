/**
 * Dynamic Workflows Integration — Capability detection
 *
 * Pure, side-effect-free probing of whether Claude Code native dynamic
 * workflows are usable. Callers pass the inputs (version string, an env getter,
 * and whether settings disabled workflows) so this is trivially testable
 * without touching disk or process.env.
 *
 * Disable surfaces (any one => unavailable), per the Claude Code docs:
 *   - env `CLAUDE_CODE_DISABLE_WORKFLOWS` truthy
 *   - `"disableWorkflows": true` in settings.json / managed settings
 *   - Claude Code older than MIN_WORKFLOW_VERSION
 */

import type { WorkflowCapability } from './types.js';

/** Minimum Claude Code version that ships dynamic workflows. */
export const MIN_WORKFLOW_VERSION = '2.1.154';

/**
 * Version at/after which the `ultracode` literal keyword triggers a workflow.
 * Before this, the literal keyword was `workflow`. Natural-language requests
 * work in both, so this only matters if a caller insists on a keyword prefix.
 */
export const ULTRACODE_KEYWORD_VERSION = '2.1.160';

type EnvGetter = (name: string) => string | undefined;

const defaultEnvGetter: EnvGetter = (name) => process.env[name];

/** Parse a dotted version ("2.1.154") into numeric parts; non-numeric => -1. */
function parseVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? -1 : n;
    });
}

/**
 * Compare two dotted version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal. Unknown/garbage sorts low.
 */
export function compareWorkflowVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** True when `version` is at least `minimum`. */
export function meetsMinimumVersion(version: string | null, minimum = MIN_WORKFLOW_VERSION): boolean {
  if (!version) return false;
  return compareWorkflowVersions(version, minimum) >= 0;
}

/** Whether the env var should be read as "disabled". */
function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface DetectWorkflowCapabilityOptions {
  /** Detected Claude Code version, or null if it could not be determined. */
  version?: string | null;
  /** `disableWorkflows` value read from settings.json / managed settings. */
  settingsDisabled?: boolean;
  /** Override env access (defaults to process.env). */
  env?: EnvGetter;
  /** Minimum version to require (defaults to MIN_WORKFLOW_VERSION). */
  minVersion?: string;
}

/**
 * Probe whether dynamic workflows are usable. Order of precedence for the
 * `disabledBy` reason: env, then settings, then version.
 */
export function detectWorkflowCapability(
  options: DetectWorkflowCapabilityOptions = {},
): WorkflowCapability {
  const {
    version = null,
    settingsDisabled = false,
    env = defaultEnvGetter,
    minVersion = MIN_WORKFLOW_VERSION,
  } = options;

  const meetsMin = meetsMinimumVersion(version, minVersion);

  if (isEnvTruthy(env('CLAUDE_CODE_DISABLE_WORKFLOWS'))) {
    return {
      available: false,
      version,
      meetsMinVersion: meetsMin,
      disabledBy: 'env',
      reason: 'Dynamic workflows disabled via CLAUDE_CODE_DISABLE_WORKFLOWS.',
    };
  }

  if (settingsDisabled) {
    return {
      available: false,
      version,
      meetsMinVersion: meetsMin,
      disabledBy: 'settings',
      reason: 'Dynamic workflows disabled via settings ("disableWorkflows": true).',
    };
  }

  if (!meetsMin) {
    return {
      available: false,
      version,
      meetsMinVersion: false,
      disabledBy: 'version',
      reason: version
        ? `Claude Code ${version} is older than the minimum ${minVersion} required for workflows.`
        : `Claude Code version unknown; workflows require ${minVersion} or later.`,
    };
  }

  return {
    available: true,
    version,
    meetsMinVersion: true,
    disabledBy: null,
    reason: `Dynamic workflows available (Claude Code ${version ?? 'unknown'}).`,
  };
}

/**
 * Whether the `ultracode` literal keyword is the right keyword for this
 * version (vs the older `workflow` literal). Natural-language requests work on
 * both, so prefer those unless a keyword prefix is explicitly configured.
 */
export function resolveDefaultTriggerKeyword(version: string | null): 'ultracode' | 'workflow' {
  if (version && compareWorkflowVersions(version, ULTRACODE_KEYWORD_VERSION) >= 0) {
    return 'ultracode';
  }
  return 'workflow';
}
