/**
 * Stale-run scan for the unattended-run watchdog (run-reaper).
 *
 * Watches the persistent unattended modes (ralph, autopilot, team,
 * ultragoal) for state files left `active: true` with a stale mtime —
 * the signature of a run whose process died mid-flight.
 *
 * Doctrine: the reaper only OBSERVES and REPORTS. It never mutates state,
 * never resumes a run, and never infers approval — re-kicking a dead run
 * is always a human decision (the launch red line).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const WATCHED_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'];

const DEFAULT_THRESHOLD_HOURS = 2; // matches the persistent-mode freshness window

// scripts/keyword-detector.mjs writes `awaiting_confirmation_set_at` in the
// same atomic write that updates the state file's mtime, so a genuinely parked
// run keeps set_at ≈ mtime no matter how many hours pass. A leftover marker
// from a run that resumed or was abandoned is followed by later state writes,
// which advance mtime past set_at. "The marker is the last write" is therefore
// what proves a stale file is parked on a prompt rather than dead. The
// tolerance only absorbs clock and write jitter.
const CONFIRMATION_MTIME_TOLERANCE_MS = 5_000;

export function staleThresholdHours() {
  const raw = Number(process.env.OMC_STALE_RUN_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_HOURS;
}

function isLastWriteMarker(setAt, mtimeMs, now) {
  const setAtMs = new Date(setAt).getTime();
  if (!Number.isFinite(setAtMs)) return false; // malformed timestamp
  if (setAtMs > now) return false; // future timestamps are not evidence
  return Math.abs(mtimeMs - setAtMs) <= CONFIRMATION_MTIME_TOLERANCE_MS;
}

function inspectStateFile(path, now, thresholdMs) {
  let mtimeMs;
  let state;
  try {
    mtimeMs = statSync(path).mtimeMs;
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // unreadable or malformed state is never a finding
  }
  if (!state || state.active !== true) return null;
  const ageHours = Math.max(0, (now - mtimeMs) / 3600_000);
  if (now - mtimeMs <= thresholdMs) return null;
  const sessionId = state.session_id ?? state.sessionId;
  // A run parked on a confirmation prompt emits no mtime updates, so it can
  // cross the threshold while the process is still alive. Report it with
  // waiting wording only when the marker is still the file's last write (see
  // CONFIRMATION_MTIME_TOLERANCE_MS above); otherwise it has been superseded.
  const awaitingConfirmationSetAt =
    typeof state.awaiting_confirmation_set_at === 'string'
      ? state.awaiting_confirmation_set_at
      : null;
  const awaitingConfirmation =
    state.awaiting_confirmation === true &&
    awaitingConfirmationSetAt !== null &&
    isLastWriteMarker(awaitingConfirmationSetAt, mtimeMs, now);
  return {
    ageHours: Math.round(ageHours * 10) / 10,
    ownerSessionId: typeof sessionId === 'string' ? sessionId : null,
    awaitingConfirmation,
    awaitingConfirmationSetAt: awaitingConfirmation
      ? awaitingConfirmationSetAt
      : null,
  };
}

/**
 * Scan the state root for stale active unattended-mode state files.
 *
 * Covers both layouts: the legacy `.omc/state/<mode>-state.json` and the
 * session-scoped `.omc/state/sessions/<sessionId>/<mode>-state.json`.
 *
 * @param {object} options
 * @param {string} options.stateRoot - Absolute path to the .omc root
 * @param {number} [options.now] - Epoch ms (defaults to Date.now())
 * @param {number} [options.thresholdHours] - Overrides the env-derived threshold
 * @param {string} [options.excludeSessionId] - Skip state under this session id
 * @returns {Promise<Array<{mode: string, path: string, sessionId: string|null, ageHours: number, awaitingConfirmation: boolean, awaitingConfirmationSetAt: string|null}>>}
 *   Stale entries, most stale first.
 */
export async function findStaleRuns({
  stateRoot,
  now = Date.now(),
  thresholdHours,
  excludeSessionId,
}) {
  const thresholdMs = (thresholdHours ?? staleThresholdHours()) * 3600_000;
  const stateDir = join(stateRoot, 'state');
  const sessionsDir = join(stateDir, 'sessions');
  const entries = [];
  let sessionIds = [];
  try {
    sessionIds = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No session-scoped layout for this state root.
  }

  for (const mode of WATCHED_MODES) {
    const legacy = inspectStateFile(
      join(stateDir, `${mode}-state.json`),
      now,
      thresholdMs,
    );
    if (legacy && legacy.ownerSessionId !== excludeSessionId) {
      entries.push({
        mode,
        path: join(stateDir, `${mode}-state.json`),
        sessionId: legacy.ownerSessionId,
        ageHours: legacy.ageHours,
        awaitingConfirmation: legacy.awaitingConfirmation,
        awaitingConfirmationSetAt: legacy.awaitingConfirmationSetAt,
      });
    }

    for (const sessionId of sessionIds) {
      if (excludeSessionId && sessionId === excludeSessionId) continue;
      const scoped = inspectStateFile(
        join(sessionsDir, sessionId, `${mode}-state.json`),
        now,
        thresholdMs,
      );
      if (
        scoped &&
        (!scoped.ownerSessionId || scoped.ownerSessionId === sessionId)
      ) {
        entries.push({
          mode,
          path: join(sessionsDir, sessionId, `${mode}-state.json`),
          sessionId,
          ageHours: scoped.ageHours,
          awaitingConfirmation: scoped.awaitingConfirmation,
          awaitingConfirmationSetAt: scoped.awaitingConfirmationSetAt,
        });
      }
    }
  }

  return entries.sort((a, b) => b.ageHours - a.ageHours);
}
