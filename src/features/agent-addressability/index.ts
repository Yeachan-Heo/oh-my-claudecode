/**
 * Agent Addressability & Discoverability Contract
 *
 * Fixes #3665: background agents spawned via the Agent tool with a
 * `description` but no explicit `name` are unaddressable — listings show raw
 * ids only, while notifications refer to them by description. This module is
 * the narrow contract those surfaces share:
 *
 * - Discoverability: unnamed agents are listed as `description (short-id)` so
 *   the coordinator can map the work it reasoned about back to an id.
 * - Addressability: exact resolution by explicit name (unchanged), full id,
 *   or — for unnamed agents only — the full description, when unambiguous.
 *
 * Safety rules baked into the contract:
 * - Exact matching only: never prefix, substring, or truncated matching, so a
 *   truncated display string can never accidentally resolve (no truncation
 *   ambiguity).
 * - Explicit names are authoritative: a description can never shadow or spoof
 *   a named agent's address, and ids take precedence over descriptions.
 * - Duplicate descriptions never resolve by description — the result is
 *   `ambiguous` and the caller must disambiguate with the id.
 * - Explicitly named agents are addressed exactly as before (backward
 *   compatible); the contract only ADDS description-based addressing for
 *   agents without a name.
 * - Only the user-supplied `description` field is ever surfaced — never the
 *   prompt or output (no privacy leaks).
 *
 * All functions are pure and operate on agent lists supplied by the caller,
 * so per-session address spaces stay isolated: resolve within the list of the
 * session you are addressing.
 */

import { truncateToWidth } from '../../utils/string-width.js';

/** Lifecycle status of an agent. */
export type AgentStatus = 'running' | 'completed' | 'failed';

/** Minimal agent shape the addressability contract operates on. */
export interface AddressableAgent {
  /** Stable opaque agent id (Claude Code agent_id / tool_use block id). */
  id: string;
  /** Agent type/role (e.g. "general-purpose", "oh-my-claudecode:executor"). */
  type?: string;
  /** Explicit user-chosen name (Agent tool `name`). Authoritative address. */
  name?: string;
  /** User-supplied description (Agent tool `description`). */
  description?: string;
  /** Lifecycle status. */
  status?: AgentStatus;
  /** Owning session id — used to keep per-session address spaces isolated. */
  sessionId?: string;
  /** Start time, used for "started Xm ago" rendering. */
  startedAt?: Date | string;
}

/** Length of the short-id suffix used in listings and notification references. */
export const SHORT_ID_LENGTH = 7;

/**
 * First `length` characters of an agent id. Short ids are for DISPLAY and
 * disambiguation only — they are never valid addresses (see `resolveAgent`).
 */
export function shortId(id: string, length: number = SHORT_ID_LENGTH): string {
  if (!id) return '';
  return id.length <= length ? id : id.slice(0, length);
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** True when the agent carries a usable explicit name. */
export function hasExplicitName(agent: AddressableAgent): boolean {
  return trimmed(agent.name).length > 0;
}

/** True when the agent carries a usable description. */
export function hasDescription(agent: AddressableAgent): boolean {
  return trimmed(agent.description).length > 0;
}

/**
 * Full, exact address for an agent: explicit name when present, else the full
 * description (unnamed agents), else the full id. Never truncated.
 */
export function addressFor(agent: AddressableAgent): string {
  const name = trimmed(agent.name);
  if (name) return name;
  const description = trimmed(agent.description);
  if (description) return description;
  return agent.id;
}

/**
 * Display label for a listing row.
 * - Named agents: their name (unchanged — backward compatible).
 * - Unnamed with description: `description (short-id)` — the short id makes
 *   the row disambiguable at a glance (the full id remains the address).
 * - Unnamed without description: the full id.
 *
 * Truncation applies to display only and always preserves the id suffix.
 */
export function listingLabel(agent: AddressableAgent, maxWidth: number = 40): string {
  const name = trimmed(agent.name);
  if (name) return name;

  const description = trimmed(agent.description);
  if (description) {
    const suffix = ` (${shortId(agent.id)})`;
    // Reserve room for " (short-id)" (10 columns) plus the ellipsis that
    // truncateToWidth may append, so the label never exceeds maxWidth.
    const budget = Math.max(4, maxWidth - SHORT_ID_LENGTH - 3 - 3);
    return `${truncateToWidth(description, budget)}${suffix}`;
  }

  return agent.id;
}

/**
 * Stable, full reference for notifications. Unlike `listingLabel` this is
 * NEVER truncated: the string shown in a notification can be passed back to a
 * messaging surface and resolved exactly.
 */
export function notificationReference(agent: AddressableAgent): string {
  const name = trimmed(agent.name);
  if (name) return name;
  const description = trimmed(agent.description);
  if (description) return `${description} (${shortId(agent.id)})`;
  return agent.id;
}

/** Which address kind matched in `resolveAgent`. */
export type MatchKind = 'name' | 'id' | 'description';

export type ResolveResult =
  | { resolved: true; agent: AddressableAgent; matchedBy: MatchKind }
  | {
      resolved: false;
      reason: 'empty' | 'not_found' | 'ambiguous';
      matchedBy?: MatchKind;
      /** Colliding candidates when the query is ambiguous (ids included). */
      candidates?: AddressableAgent[];
    };

function exactlyOne<T>(matches: T[]): T | null {
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve a recipient string to an agent using EXACT matching only.
 *
 * Precedence:
 * 1. explicit `name` — authoritative; unchanged behavior for named agents
 * 2. full `id` — stable, always available
 * 3. full `description` — unnamed agents only, and only when unique
 *
 * Never prefix, substring, or truncated matching. Duplicate names or
 * descriptions resolve as `ambiguous`; the caller must disambiguate with the
 * id (both colliding agents are surfaced in `candidates`).
 *
 * Pass the agent list of the session you are addressing so address spaces
 * stay isolated across sessions.
 */
export function resolveAgent(
  agents: readonly AddressableAgent[],
  query: string,
): ResolveResult {
  const needle = trimmed(query);
  if (!needle) return { resolved: false, reason: 'empty' };

  // 1. Explicit names are authoritative — a description can never spoof one.
  const byName = agents.filter(
    (agent) => hasExplicitName(agent) && trimmed(agent.name) === needle,
  );
  if (byName.length > 0) {
    const single = exactlyOne(byName);
    return single
      ? { resolved: true, agent: single, matchedBy: 'name' }
      : {
          resolved: false,
          reason: 'ambiguous',
          matchedBy: 'name',
          candidates: byName,
        };
  }

  // 2. Full ids (short ids are NOT addresses — ids are matched in full).
  const byId = agents.filter((agent) => agent.id === needle);
  if (byId.length > 0) {
    const single = exactlyOne(byId);
    return single
      ? { resolved: true, agent: single, matchedBy: 'id' }
      : {
          resolved: false,
          reason: 'ambiguous',
          matchedBy: 'id',
          candidates: byId,
        };
  }

  // 3. Full description — unnamed agents only. Named agents keep name
  //    addressing; their descriptions must not shadow other addresses.
  const byDescription = agents.filter(
    (agent) =>
      !hasExplicitName(agent) &&
      hasDescription(agent) &&
      trimmed(agent.description) === needle,
  );
  if (byDescription.length > 0) {
    const single = exactlyOne(byDescription);
    return single
      ? { resolved: true, agent: single, matchedBy: 'description' }
      : {
          resolved: false,
          reason: 'ambiguous',
          matchedBy: 'description',
          candidates: byDescription,
        };
  }

  return { resolved: false, reason: 'not_found' };
}

export interface FormatAgentListOptions {
  /** Listing title (default: "Subagents"). */
  title?: string;
  /** Show lifecycle status column (default: true). */
  showStatus?: boolean;
  /** Show "started Xm ago" column (default: true). */
  showStartedAt?: boolean;
  /** Clock for relative-time rendering (default: new Date()). */
  now?: Date;
}

function formatAgo(
  startedAt: Date | string | undefined,
  now: Date,
): string | null {
  if (startedAt === undefined) return null;
  const start =
    startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const elapsedSec = Math.max(0, Math.floor((now.getTime() - start) / 1000));
  if (elapsedSec < 60) return 'just now';
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
  if (elapsedSec < 86400) return `${Math.floor(elapsedSec / 3600)}h ago`;
  return `${Math.floor(elapsedSec / 86400)}d ago`;
}

/**
 * Render a ListAgents-style listing. Every row carries the full id so any row
 * can be used to address the agent exactly:
 *
 *   Subagents (3):
 *     S2 nspin4 A/B vehicle · general-purpose · running · started 19m ago · ae1e2be26cb41fc74
 *     worker-1 · general-purpose · running · started 18m ago · a31df4cfac7e5ba7f
 *
 * Named agents keep their name as the label (unchanged); unnamed agents get
 * `description (short-id)`.
 */
export function formatAgentList(
  agents: readonly AddressableAgent[],
  options: FormatAgentListOptions = {},
): string {
  const {
    title = 'Subagents',
    showStatus = true,
    showStartedAt = true,
    now = new Date(),
  } = options;

  const header = `${title} (${agents.length}):`;
  if (agents.length === 0) return `${header}\n  (none)`;

  const rows = agents.map((agent) => {
    const label = listingLabel(agent, 48);
    const parts: string[] = [label];
    const type = trimmed(agent.type);
    if (type) parts.push(type);
    if (showStatus && agent.status) parts.push(agent.status);
    if (showStartedAt) {
      const ago = formatAgo(agent.startedAt, now);
      if (ago) parts.push(`started ${ago}`);
    }
    // Full id always present so the row is directly addressable. Omit the
    // trailing id column when the id is already the label (unnamed agent with
    // no description) to avoid duplication.
    if (label !== agent.id) parts.push(agent.id);
    return `  ${parts.join(' · ')}`;
  });

  return `${header}\n${rows.join('\n')}`;
}
