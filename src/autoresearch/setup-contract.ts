import { parseSandboxContract, slugifyMissionName, type AutoresearchKeepPolicy } from './contracts.js';

export const AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD = 0.8;

export type AutoresearchSetupEvaluatorSource = 'user' | 'inferred';

export interface AutoresearchSetupHandoff {
  missionText: string;
  evaluatorCommand: string;
  evaluatorSource: AutoresearchSetupEvaluatorSource;
  confidence: number;
  keepPolicy?: AutoresearchKeepPolicy;
  slug: string;
  readyToLaunch: boolean;
  clarificationQuestion?: string;
  repoSignals?: string[];
}

function contractError(message: string): Error {
  return new Error(message);
}

function normalizeConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || Number.isNaN(raw) || !Number.isFinite(raw)) {
    throw contractError('setup handoff confidence must be a finite number between 0 and 1.');
  }
  if (raw < 0 || raw > 1) {
    throw contractError('setup handoff confidence must be between 0 and 1.');
  }
  return raw;
}

function parseKeepPolicy(raw: unknown): AutoresearchKeepPolicy | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw contractError('setup handoff keepPolicy must be a string when provided.');
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'score_improvement' || normalized === 'pass_only') {
    return normalized;
  }
  throw contractError('setup handoff keepPolicy must be one of: score_improvement, pass_only.');
}

export function buildSetupSandboxContent(
  evaluatorCommand: string,
  keepPolicy?: AutoresearchKeepPolicy,
): string {
  const safeCommand = evaluatorCommand.replace(/[\r\n]/g, ' ').trim();
  const keepPolicyLine = keepPolicy ? `\n  keep_policy: ${keepPolicy}` : '';
  return `---\nevaluator:\n  command: ${safeCommand}\n  format: json${keepPolicyLine}\n---\n`;
}

export function validateAutoresearchSetupHandoff(raw: unknown): AutoresearchSetupHandoff {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw contractError('setup handoff must be a JSON object.');
  }

  const candidate = raw as Record<string, unknown>;
  const missionText = typeof candidate.missionText === 'string' ? candidate.missionText.trim() : '';
  const evaluatorCommand = typeof candidate.evaluatorCommand === 'string' ? candidate.evaluatorCommand.trim() : '';
  const evaluatorSource = candidate.evaluatorSource;
  const confidence = normalizeConfidence(candidate.confidence);
  const keepPolicy = parseKeepPolicy(candidate.keepPolicy);
  const slugInput = typeof candidate.slug === 'string' ? candidate.slug.trim() : missionText;
  const slug = slugifyMissionName(slugInput);
  const readyToLaunch = candidate.readyToLaunch;
  const clarificationQuestion = typeof candidate.clarificationQuestion === 'string'
    ? candidate.clarificationQuestion.trim()
    : undefined;
  const repoSignals = Array.isArray(candidate.repoSignals)
    ? candidate.repoSignals.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined;

  if (!missionText) {
    throw contractError('setup handoff missionText is required.');
  }
  if (!evaluatorCommand) {
    throw contractError('setup handoff evaluatorCommand is required.');
  }
  if (evaluatorSource !== 'user' && evaluatorSource !== 'inferred') {
    throw contractError('setup handoff evaluatorSource must be "user" or "inferred".');
  }
  if (typeof readyToLaunch !== 'boolean') {
    throw contractError('setup handoff readyToLaunch must be boolean.');
  }

  parseSandboxContract(buildSetupSandboxContent(evaluatorCommand, keepPolicy));

  if (evaluatorSource === 'inferred' && confidence < AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD && readyToLaunch) {
    throw contractError('low-confidence inferred evaluators cannot be marked readyToLaunch.');
  }

  if (!readyToLaunch && !clarificationQuestion) {
    throw contractError('setup handoff must include clarificationQuestion when launch is blocked.');
  }

  return {
    missionText,
    evaluatorCommand,
    evaluatorSource,
    confidence,
    ...(keepPolicy ? { keepPolicy } : {}),
    slug,
    readyToLaunch,
    ...(clarificationQuestion ? { clarificationQuestion } : {}),
    ...(repoSignals && repoSignals.length > 0 ? { repoSignals } : {}),
  };
}

export function parseAutoresearchSetupHandoffJson(raw: string): AutoresearchSetupHandoff {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonPayload = fencedMatch?.[1]?.trim() ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch {
    throw contractError('setup handoff must be valid JSON.');
  }
  return validateAutoresearchSetupHandoff(parsed);
}
