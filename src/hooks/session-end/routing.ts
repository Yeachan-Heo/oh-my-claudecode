export type ChainOutcome = 'success' | 'failed' | 'needs-human';

export interface ChainDirective {
  stage: string;
  skill: string;
}

export type RouteTable = Readonly<Record<string, ChainDirective>>;

/**
 * Keep only well-formed `outcome:reason` directives. A table written in the
 * nested shape (`{ success: { other: {...} } }`) yields no flat key, so
 * `decideNextStage` returns null and the chain halts as `no-route` — silently,
 * because a malformed table and a deliberate terminal look identical downstream.
 * Nested groups (keys without `:`) and non-directive entries are dropped.
 * Returns null for non-objects; an empty object is a valid, authoritative
 * empty table.
 */
export function normalizeRouteTable(input: unknown): RouteTable | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return {};
  const directives: Record<string, ChainDirective> = {};
  for (const [key, value] of entries) {
    if (!key.includes(':')) continue;
    if (!value || typeof value !== 'object') continue;
    const { stage, skill } = value as { stage?: unknown; skill?: unknown };
    if (typeof stage !== 'string' || typeof skill !== 'string') continue;
    directives[key] = { stage, skill };
  }
  return Object.keys(directives).length > 0 ? directives : null;
}

export function decideNextStage(outcome: ChainOutcome, reason: string, table: RouteTable): ChainDirective | null {
  return table[`${outcome}:${reason}`] ?? table[`${outcome}:*`] ?? null;
}

export type GateName = 'intent-accept' | 'spec-approve' | 'harbor-review' | 'review-approve';

export interface GateFacts {
  irreversibleOrExternal: boolean;
  precedentSetting: boolean;
  valueJudgment: boolean;
  mechanicalChecksPassed: boolean;
}

export type GateVerdict =
  | { kind: 'human'; criterion: string }
  | { kind: 'auto-pass'; signerFact: string };

const CRITERIA: ReadonlyArray<[keyof Pick<GateFacts, 'irreversibleOrExternal' | 'precedentSetting' | 'valueJudgment'>, string]> = [
  ['irreversibleOrExternal', '判据一：不可逆或外部可见'],
  ['precedentSetting', '判据二：先例性'],
  ['valueJudgment', '判据三：价值判断'],
];

export function gradeGate(gate: GateName, facts: GateFacts): GateVerdict {
  if (gate === 'intent-accept') return { kind: 'human', criterion: '保留人闸：价值判断 + 消耗下游整条链，v1 无自动通道' };
  if (gate === 'review-approve') return { kind: 'human', criterion: '保留人闸：合并不可逆且外部可见（判据一），v1 无黑区' };
  for (const [key, label] of CRITERIA) {
    if (facts[key]) return { kind: 'human', criterion: label };
  }
  if (!facts.mechanicalChecksPassed) return { kind: 'human', criterion: '机械验证项未全部通过' };
  return { kind: 'auto-pass', signerFact: '分级判据均未触发，机械验证项全部通过，自动过' };
}
