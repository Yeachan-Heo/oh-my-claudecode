import type { ComplexityTier } from "./types.js";
import type { ModelType } from "../../shared/types.js";
import { escalateModel, canEscalate } from "./router.js";
import { TIER_TO_MODEL_TYPE } from "./types.js";

/** Configuration for escalation behavior */
export interface EscalationConfig {
  /** Whether escalation is enabled */
  enabled: boolean;
  /** Maximum escalation attempts per task */
  maxAttempts: number;
  /** Minimum tier floor (never go below this) */
  minimumTier?: ComplexityTier;
  /** Force specific agents to specific tiers */
  forceTierByAgent?: Record<string, ComplexityTier>;
  /** Cooldown between escalations in ms */
  cooldownMs?: number;
}

/** Outcome of a verification check */
export interface VerificationOutcome {
  /** Whether the task succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Category of failure */
  failureType?: "build" | "test" | "lint" | "runtime" | "timeout" | "unknown";
  /** Duration in ms */
  durationMs?: number;
}

/** Record of an escalation attempt */
export interface EscalationRecord {
  /** Original tier */
  fromTier: ComplexityTier;
  /** Escalated tier */
  toTier: ComplexityTier;
  /** Why escalation was triggered */
  reason: string;
  /** Timestamp */
  timestamp: Date;
  /** Outcome after escalation */
  outcome?: VerificationOutcome;
}

/** Result of running with escalation */
export interface EscalationResult<T> {
  /** The result value (if successful) */
  value?: T;
  /** Final tier used */
  finalTier: ComplexityTier;
  /** Final model used */
  finalModel: ModelType;
  /** Whether escalation occurred */
  escalated: boolean;
  /** Total attempts */
  attempts: number;
  /** History of escalation records */
  history: EscalationRecord[];
  /** Final outcome */
  outcome: VerificationOutcome;
}

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  enabled: true,
  maxAttempts: 3,
  minimumTier: undefined,
  forceTierByAgent: undefined,
  cooldownMs: 0,
};

const TIER_ORDER: ComplexityTier[] = ["LOW", "MEDIUM", "HIGH"];

function clampToMinimum(
  tier: ComplexityTier,
  minimumTier?: ComplexityTier,
): ComplexityTier {
  if (!minimumTier) {
    return tier;
  }

  const tierIndex = TIER_ORDER.indexOf(tier);
  const minimumIndex = TIER_ORDER.indexOf(minimumTier);
  return tierIndex < minimumIndex ? minimumTier : tier;
}

function createRuntimeFailure(error: unknown): VerificationOutcome {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    failureType: "runtime",
  };
}

export class EscalationController {
  private config: EscalationConfig;
  private failureStore: Map<string, EscalationRecord[]> = new Map();

  constructor(config: Partial<EscalationConfig> = {}) {
    this.config = { ...DEFAULT_ESCALATION_CONFIG, ...config };
  }

  getConfig(): EscalationConfig {
    return this.config;
  }

  getEffectiveTier(
    agentType: string,
    initialTier: ComplexityTier,
  ): ComplexityTier {
    let tier = initialTier;

    if (this.config.forceTierByAgent?.[agentType]) {
      tier = this.config.forceTierByAgent[agentType];
    }

    tier = clampToMinimum(tier, this.config.minimumTier);

    const history = this.failureStore.get(agentType);
    if (history && history.length > 0) {
      tier = history[history.length - 1].toTier;
    }

    return tier;
  }

  recordFailure(
    taskId: string,
    tier: ComplexityTier,
    outcome: VerificationOutcome,
  ): ComplexityTier | null {
    const history = this.failureStore.get(taskId) ?? [];

    if (!this.config.enabled) {
      return null;
    }

    if (history.length + 1 >= this.config.maxAttempts) {
      history.push({
        fromTier: tier,
        toTier: tier,
        reason: "Max escalation attempts reached",
        timestamp: new Date(),
        outcome,
      });
      this.failureStore.set(taskId, history);
      return null;
    }

    if (!canEscalate(tier)) {
      history.push({
        fromTier: tier,
        toTier: tier,
        reason: "Already at maximum tier",
        timestamp: new Date(),
        outcome,
      });
      this.failureStore.set(taskId, history);
      return null;
    }

    const nextTier = escalateModel(tier);
    history.push({
      fromTier: tier,
      toTier: nextTier,
      reason: "Verification failed",
      timestamp: new Date(),
      outcome,
    });

    this.failureStore.set(taskId, history);
    return nextTier;
  }

  recordSuccess(taskId: string, _tier: ComplexityTier): void {
    this.failureStore.delete(taskId);
  }

  getHistory(taskId: string): EscalationRecord[] {
    return this.failureStore.get(taskId) ?? [];
  }

  clearHistory(taskId?: string): void {
    if (!taskId) {
      this.failureStore.clear();
      return;
    }

    this.failureStore.delete(taskId);
  }

  canEscalateTask(taskId: string): boolean {
    const history = this.failureStore.get(taskId) ?? [];
    if (history.length === 0) {
      return true;
    }

    if (history.length >= this.config.maxAttempts) {
      return false;
    }

    const lastTier = history[history.length - 1].toTier;
    return canEscalate(lastTier);
  }
}

async function wait(ms: number): Promise<void> {
  if (!ms || ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithEscalation<T>(
  taskId: string,
  initialTier: ComplexityTier,
  execute: (
    tier: ComplexityTier,
    model: ModelType,
    attempt: number,
  ) => Promise<T>,
  verify: (result: T) => VerificationOutcome,
  config: Partial<EscalationConfig> = {},
): Promise<EscalationResult<T>> {
  const controller = new EscalationController(config);
  const effectiveConfig = controller.getConfig();
  let tier = controller.getEffectiveTier(taskId, initialTier);
  let attempt = 0;
  let lastOutcome: VerificationOutcome = {
    success: false,
    failureType: "unknown",
  };
  let lastValue: T | undefined;

  while (attempt < effectiveConfig.maxAttempts) {
    attempt += 1;
    const modelType = TIER_TO_MODEL_TYPE[tier];

    try {
      lastValue = await execute(tier, modelType, attempt);
      lastOutcome = verify(lastValue);
    } catch (error) {
      lastOutcome = createRuntimeFailure(error);
    }

    if (lastOutcome.success) {
      controller.recordSuccess(taskId, tier);
      return {
        value: lastValue,
        finalTier: tier,
        finalModel: modelType,
        escalated: attempt > 1,
        attempts: attempt,
        history: controller.getHistory(taskId),
        outcome: lastOutcome,
      };
    }

    const nextTier = controller.recordFailure(taskId, tier, lastOutcome);
    if (!nextTier) {
      return {
        value: lastValue,
        finalTier: tier,
        finalModel: modelType,
        escalated: attempt > 1,
        attempts: attempt,
        history: controller.getHistory(taskId),
        outcome: lastOutcome,
      };
    }

    await wait(effectiveConfig.cooldownMs ?? 0);
    tier = nextTier;
  }

  return {
    value: lastValue,
    finalTier: tier,
    finalModel: TIER_TO_MODEL_TYPE[tier],
    escalated: attempt > 1,
    attempts: attempt,
    history: controller.getHistory(taskId),
    outcome: lastOutcome,
  };
}
