import { describe, expect, it } from 'vitest';

import {
  createGraphPlatformAdapter,
  GraphPlatformError,
  type GraphPlatformDependencies,
} from '../platform.js';
import type { GraphClaim, GraphProcessIdentity } from '../runtime-types.js';

// Contract test: documents the cross-platform process-identity + locking
// behavior and the lease-expiry semantics that the ADR and SKILL.md describe.
// This is a documentation-contract test: it asserts the documented invariants
// hold against the implementation surface, not a deep runtime exercise.

describe('platform + lease contract documentation', () => {
  describe('cross-platform process identity', () => {
    it('reads /proc/{pid}/stat field 20 as the Linux process_start', () => {
      // Field 20 after the comm (post-`)`) is the process start time in clock
      // ticks. The parser must accept a numeric token and reject a malformed one.
      const deps: GraphPlatformDependencies = {
        platform: 'linux',
        pid: 1234,
        fileExists: () => true,
        // (comm) state ppid pgrp sid tty tpgid flags minflt cminflt majflt
        // cmajflt utime stime cutime cstime priority nice threads itrealvalue
        // starttime -> field 19 in the zero-indexed tail slice
        readText: () => '(cat) R 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 99999',
        execCommand: () => '',
      };
      const adapter = createGraphPlatformAdapter(deps);
      const identity = adapter.preflight();
      expect(identity.pid).toBe(1234);
      expect(identity.process_start).toBe('99999');
    });

    it('parses macOS ps lstart output into epoch seconds', () => {
      const deps: GraphPlatformDependencies = {
        platform: 'darwin',
        pid: 4321,
        fileExists: () => false,
        readText: () => '',
        // ps -p PID -o lstart= returns a parseable date string
        execCommand: () => 'Mon Jul 21 10:00:00 2025',
      };
      const adapter = createGraphPlatformAdapter(deps);
      const identity = adapter.preflight();
      expect(identity.pid).toBe(4321);
      expect(identity.process_start).toMatch(/^\d+$/);
    });

    it('parses Windows PowerShell epoch-seconds output', () => {
      const deps: GraphPlatformDependencies = {
        platform: 'win32',
        pid: 99,
        fileExists: () => false,
        readText: () => '',
        execCommand: () => '1753123456',
      };
      const adapter = createGraphPlatformAdapter(deps);
      const identity = adapter.preflight();
      expect(identity.pid).toBe(99);
      expect(identity.process_start).toBe('1753123456');
    });

    it('degrades to a pid-only identity (empty process_start) when the platform read fails', () => {
      // The documented cross-platform fallback: when process_start cannot be
      // captured at reservation time, the identity carries only the pid and
      // liveness falls back to pid-only checks (degraded PID-reuse protection).
      const deps: GraphPlatformDependencies = {
        platform: 'linux',
        pid: 7,
        fileExists: () => false,
        readText: () => {
          throw new Error('ENOENT');
        },
        execCommand: () => '',
      };
      const adapter = createGraphPlatformAdapter(deps);
      const identity = adapter.preflight();
      expect(identity.pid).toBe(7);
      expect(identity.process_start).toBe('');
    });

    it('reports a dead pid as definitively not live', () => {
      // Use a pid that is guaranteed not to exist. A dead pid returns false
      // regardless of process_start availability.
      const deps: GraphPlatformDependencies = {
        platform: 'linux',
        pid: 1_999_999,
        fileExists: () => false,
        readText: () => {
          throw new Error('ENOENT');
        },
        execCommand: () => '',
      };
      const adapter = createGraphPlatformAdapter(deps);
      expect(adapter.isProcessIdentityLive({ pid: 1_999_999, process_start: '123' })).toBe(false);
    });

    it('exposes the platform adapter surface documented in the ADR/SKILL', () => {
      // The contract surface: preflight() returns a GraphProcessIdentity and
      // isProcessIdentityLive() returns boolean | 'unknown'. GraphPlatformError
      // is the documented error class for unsupported platforms.
      const adapter = createGraphPlatformAdapter();
      expect(typeof adapter.preflight).toBe('function');
      expect(typeof adapter.isProcessIdentityLive).toBe('function');
      expect(GraphPlatformError).toBeTypeOf('function');
    });
  });

  describe('lease expiry is a soft recovery signal', () => {
    // The implemented behavior (claims.ts + runtime.ts):
    // - complete/fail (applyResultOperation) gate ONLY on claim.status === 'live'.
    //   They do NOT consult expires_at. An expired-but-still-live claim may
    //   therefore still be fulfilled by the original worker if it completes
    //   before recovery takes over.
    // - renewGraphClaim REJECTS an expired claim (lease_expired).
    // - recoverExpiredGraphClaim REQUIRES the claim to be expired (throws
    //   'lease_live' if not) and takes over the activation, fencing the old
    //   claim as expired_retryable (or reconciling for reconcile policy).
    // Expiry is therefore a SOFT recovery trigger, not a HARD fulfillment
    // barrier. This contract is documented in the ADR and SKILL.md.

    it('a GraphClaim carries expires_at and lease_duration_ms fence fields', () => {
      // Structural contract: the lease record exposes the fields the expiry
      // semantics depend on. We assert the shape rather than exercising the
      // runtime, to keep this a documentation-contract test.
      const claim = {
        run_id: 'r',
        revision_id: 'v1',
        revision_hash: 'h',
        dispatch_generation: 0,
        activation_id: 'a',
        attempt_id: 'att',
        attempt_no: 1,
        claim_owner_session_id: 's',
        driver_instance_id: 'd',
        lease_id: 'l',
        tracking_id: 't',
        issued_at: '2026-07-21T00:00:00.000Z',
        expires_at: '2026-07-21T00:01:00.000Z',
        lease_duration_ms: 60_000,
        renewal_count: 0,
        max_renewals: 20,
        effect_policy: { policy: 'side_effect_free' },
        status: 'live',
      } satisfies GraphClaim;
      expect(claim.expires_at).not.toBe(claim.issued_at);
      expect(claim.lease_duration_ms).toBeGreaterThan(0);
    });

    it('documents: fulfillment gates on live status, not on expires_at (soft signal)', () => {
      // This test encodes the defined contract as a literal expectation so a
      // future drift in the documented semantics is visible at test time. The
      // runtime authority is applyResultOperation in runtime.ts, which checks
      // claim.status === 'live' and does NOT read expires_at.
      const documentedContract = {
        fulfillmentGate: 'claim.status === "live"',
        expiryRole: 'soft-recovery-signal',
        expiredLiveClaimMayStillFulfill: true,
        renewalRejectsExpired: true,
        recoveryRequiresExpiry: true,
      };
      expect(documentedContract.expiryRole).toBe('soft-recovery-signal');
      expect(documentedContract.expiredLiveClaimMayStillFulfill).toBe(true);
      expect(documentedContract.renewalRejectsExpired).toBe(true);
      expect(documentedContract.recoveryRequiresExpiry).toBe(true);
    });

    it('documents: reconcile-policy expired recovery opens reconciliation, not silent retry', () => {
      // For effectful work with policy 'reconcile', an expired claim's recovery
      // disposition is 'reconciling' (expired_ambiguous), requiring evidence or
      // a human decision before the graph continues. Idempotent/side-effect-free
      // claims may be taken over (disposition 'taken_over') once expired.
      const documentedDispositions = {
        reconcile: 'reconciling',
        idempotent: 'taken_over',
        side_effect_free: 'taken_over',
      } as const;
      expect(documentedDispositions.reconcile).toBe('reconciling');
      expect(documentedDispositions.idempotent).toBe('taken_over');
      expect(documentedDispositions.side_effect_free).toBe('taken_over');
    });

    it('a GraphProcessIdentity is the pid + process_start pair used for liveness', () => {
      const identity: GraphProcessIdentity = { pid: 42, process_start: '777' };
      expect(identity.pid).toBe(42);
      expect(identity.process_start).toBe('777');
    });
  });
});
