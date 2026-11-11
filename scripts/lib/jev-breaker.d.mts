export interface BreakerSettings {
  breaker: boolean;
  maxRpm: number | undefined;
  dir: string;
  /** Pause after a breaker write in milliseconds (tests only; default 50). */
  settleMs?: number;
}

export interface OpenBreaker {
  until: number;
  reason: string;
  since: number;
}

export interface FailureClass {
  reason: string;
  opens: boolean;
  seconds?: number;
}

export type AdmissionSkip =
  | { mode: 'circuit-open'; breaker: OpenBreaker }
  | { mode: 'cap'; priority: string; count: number; threshold: number; limit: number };

export const BREAKER_SECONDS: { transient: number; account: number; noResponse: number };
export const BREAKER_MAX_SECONDS: number;
export const POINT_PRIORITY: Readonly<Record<string, 'high' | 'medium' | 'low'>>;
export const PRIORITY_SHARE: Readonly<Record<'high' | 'medium' | 'low', number>>;

export function pointPriority(point: string): 'high' | 'medium' | 'low';
export function thresholdFor(limit: number, point: string): number;
export function parseMaxRpm(raw: string | undefined): number | undefined;
export function breakerSettings(env: NodeJS.ProcessEnv, endpoint: string, apiKey: string | null | undefined): BreakerSettings | undefined;
export function readBreaker(settings: BreakerSettings | undefined, now?: number): OpenBreaker | undefined;
export function retryAfterSeconds(value: string | null | undefined, now?: number): number | undefined;
export const RETRY_BODY_MAX_CHARS: number;
export function retryAfterFromBody(text: string | undefined): number | undefined;
export function classifyFailure(
  failure: { status?: number; retryAfter?: string | null; body?: string; noResponse?: boolean } | undefined,
  now?: number,
): FailureClass | undefined;
export function recordFailure(settings: BreakerSettings | undefined, failure: FailureClass | undefined, now?: number): OpenBreaker | undefined;
export function minuteKey(now?: number): string;
export function reserveRequest(
  settings: BreakerSettings | undefined,
  point: string,
  now?: number,
): { ok: boolean; priority?: string; count?: number; threshold?: number; limit?: number };
export function admitRequest(settings: BreakerSettings | undefined, point: string, now?: number): { skip?: AdmissionSkip };
export function skipLogFields(skip: AdmissionSkip): {
  reason: string;
  until?: string;
  priority?: string;
  rpm?: { count: number; threshold: number; limit: number };
};
export function outageMessage(breaker: OpenBreaker): string;
export function claimOutageNotice(
  settings: BreakerSettings | undefined,
  sessionId: string | undefined,
  breaker: OpenBreaker | undefined,
  now?: number,
): string | undefined;
