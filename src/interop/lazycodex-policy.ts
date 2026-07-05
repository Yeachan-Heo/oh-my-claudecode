import { z } from 'zod';

export type LazyCodexPolicyFeature = 'autoUpdate' | 'globalClaudeMutation' | 'telemetry';
export type LazyCodexPolicyEffectName = LazyCodexPolicyFeature;
export type LazyCodexPolicySource = 'default' | 'config' | 'env' | 'invalid-config' | 'invalid-env';

export interface LazyCodexPolicyOptIn {
  readonly feature: LazyCodexPolicyFeature;
  readonly source: 'config' | 'env';
  readonly key: string;
}

export interface LazyCodexPolicyDecision {
  readonly enabled: boolean;
  readonly source: LazyCodexPolicySource;
  readonly key?: string;
  readonly reason: string;
}

export interface LazyCodexPolicy {
  readonly autoUpdate: boolean;
  readonly globalClaudeMutation: boolean;
  readonly telemetry: boolean;
  readonly decisions: {
    readonly autoUpdate: LazyCodexPolicyDecision;
    readonly globalClaudeMutation: LazyCodexPolicyDecision;
    readonly telemetry: LazyCodexPolicyDecision;
  };
  readonly optInTrail: readonly LazyCodexPolicyOptIn[];
  readonly warnings: readonly string[];
}

export interface LazyCodexPolicyInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: unknown;
}

export interface LazyCodexPolicyEffects {
  readonly startAutoUpdate: () => void;
  readonly migrateGlobalClaudeConfig: () => void;
  readonly sendTelemetry: () => void;
}

export interface LazyCodexPolicyRunReport {
  readonly effects: {
    readonly autoUpdate: boolean;
    readonly globalClaudeMutation: boolean;
    readonly telemetry: boolean;
  };
}

interface FeatureDescriptor {
  readonly feature: LazyCodexPolicyFeature;
  readonly configKey: string;
  readonly envKey: string;
}

interface FeatureEvaluationInput {
  readonly descriptor: FeatureDescriptor;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly lazycodexConfig: Readonly<Record<string, unknown>> | null;
}

interface FeatureEvaluation {
  readonly decision: LazyCodexPolicyDecision;
  readonly warning?: string;
}

const RecordSchema = z.record(z.unknown());

const AutoUpdateDescriptor = {
  feature: 'autoUpdate',
  configKey: 'lazycodex.autoUpdate',
  envKey: 'OMC_LAZYCODEX_AUTO_UPDATE',
} as const satisfies FeatureDescriptor;

const GlobalClaudeMutationDescriptor = {
  feature: 'globalClaudeMutation',
  configKey: 'lazycodex.globalClaudeMutation',
  envKey: 'OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION',
} as const satisfies FeatureDescriptor;

const TelemetryDescriptor = {
  feature: 'telemetry',
  configKey: 'lazycodex.telemetry',
  envKey: 'OMC_LAZYCODEX_TELEMETRY',
} as const satisfies FeatureDescriptor;

const EnvValueHelp = '1, true, yes, on, 0, false, no, off';

function getLazyCodexConfig(config: unknown): Readonly<Record<string, unknown>> | null {
  const root = RecordSchema.safeParse(config);
  if (!root.success) {
    return null;
  }

  const lazycodex = RecordSchema.safeParse(root.data.lazycodex);
  return lazycodex.success ? lazycodex.data : null;
}

function parseEnvBoolean(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();

  switch (normalized) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return null;
  }
}

function evaluateFeature(input: FeatureEvaluationInput): FeatureEvaluation {
  const rawEnvValue = input.env[input.descriptor.envKey];
  if (rawEnvValue !== undefined) {
    const parsedEnvValue = parseEnvBoolean(rawEnvValue);
    if (parsedEnvValue !== null) {
      return {
        decision: {
          enabled: parsedEnvValue,
          source: 'env',
          key: input.descriptor.envKey,
          reason: parsedEnvValue ? 'explicit env opt-in' : 'explicit env opt-out',
        },
      };
    }

    return {
      decision: {
        enabled: false,
        source: 'invalid-env',
        key: input.descriptor.envKey,
        reason: 'malformed env value',
      },
      warning: `${input.descriptor.envKey} must be one of: ${EnvValueHelp}`,
    };
  }

  const configValue = input.lazycodexConfig?.[input.descriptor.feature];
  if (configValue !== undefined) {
    if (typeof configValue === 'boolean') {
      return {
        decision: {
          enabled: configValue,
          source: 'config',
          key: input.descriptor.configKey,
          reason: configValue ? 'explicit config opt-in' : 'explicit config opt-out',
        },
      };
    }

    return {
      decision: {
        enabled: false,
        source: 'invalid-config',
        key: input.descriptor.configKey,
        reason: 'malformed config value',
      },
      warning: `${input.descriptor.configKey} must be a boolean when present`,
    };
  }

  return {
    decision: {
      enabled: false,
      source: 'default',
      reason: 'disabled by default for Claude v1',
    },
  };
}

function appendOptIn(
  trail: LazyCodexPolicyOptIn[],
  feature: LazyCodexPolicyFeature,
  decision: LazyCodexPolicyDecision,
): void {
  if (!decision.enabled) {
    return;
  }

  if (decision.source !== 'config' && decision.source !== 'env') {
    return;
  }

  if (!decision.key) {
    return;
  }

  trail.push({
    feature,
    source: decision.source,
    key: decision.key,
  });
}

export function createLazyCodexPolicy(input: LazyCodexPolicyInput = {}): LazyCodexPolicy {
  const env = input.env ?? process.env;
  const lazycodexConfig = getLazyCodexConfig(input.config);
  const warnings: string[] = [];
  const optInTrail: LazyCodexPolicyOptIn[] = [];

  const autoUpdate = evaluateFeature({
    descriptor: AutoUpdateDescriptor,
    env,
    lazycodexConfig,
  });
  const globalClaudeMutation = evaluateFeature({
    descriptor: GlobalClaudeMutationDescriptor,
    env,
    lazycodexConfig,
  });
  const telemetry = evaluateFeature({
    descriptor: TelemetryDescriptor,
    env,
    lazycodexConfig,
  });

  if (autoUpdate.warning) {
    warnings.push(autoUpdate.warning);
  }
  if (globalClaudeMutation.warning) {
    warnings.push(globalClaudeMutation.warning);
  }
  if (telemetry.warning) {
    warnings.push(telemetry.warning);
  }

  appendOptIn(optInTrail, 'autoUpdate', autoUpdate.decision);
  appendOptIn(
    optInTrail,
    'globalClaudeMutation',
    globalClaudeMutation.decision,
  );
  appendOptIn(optInTrail, 'telemetry', telemetry.decision);

  return {
    autoUpdate: autoUpdate.decision.enabled,
    globalClaudeMutation: globalClaudeMutation.decision.enabled,
    telemetry: telemetry.decision.enabled,
    decisions: {
      autoUpdate: autoUpdate.decision,
      globalClaudeMutation: globalClaudeMutation.decision,
      telemetry: telemetry.decision,
    },
    optInTrail,
    warnings,
  };
}

export function applyLazyCodexPolicy(
  policy: LazyCodexPolicy,
  effects: LazyCodexPolicyEffects,
): LazyCodexPolicyRunReport {
  if (policy.autoUpdate) {
    effects.startAutoUpdate();
  }

  if (policy.globalClaudeMutation) {
    effects.migrateGlobalClaudeConfig();
  }

  if (policy.telemetry) {
    effects.sendTelemetry();
  }

  return {
    effects: {
      autoUpdate: policy.autoUpdate,
      globalClaudeMutation: policy.globalClaudeMutation,
      telemetry: policy.telemetry,
    },
  };
}
