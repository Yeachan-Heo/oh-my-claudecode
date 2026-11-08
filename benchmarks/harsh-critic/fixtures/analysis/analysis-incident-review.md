# Incident Postmortem: Payment Service Outage
**Incident ID:** INC-2026-0089
**Date of Incident:** 2026-02-19
**Date of Review:** 2026-02-26
**Severity:** S2
**Author:** Fatima Al-Hassan, Platform Engineering
**Reviewers:** Luca Bianchi (On-Call Lead), Dev Patel (Data Platform)
**Status:** Final

---

## Incident Summary

On February 19, 2026, the payment processing service experienced a complete outage for approximately 2 hours and 10 minutes, during which all payment attempts failed. The outage was caused by database slow queries that exhausted the connection pool, preventing the payment service from executing transactions. This postmortem documents the timeline, root cause, and action items to prevent recurrence.

---

## Impact

- **Duration:** 2 hours 10 minutes (13:48–15:58 UTC)
- **Service affected:** `payment-service` (all payment endpoints)
- **User-facing impact:** 100% of payment attempts (subscriptions, one-time purchases) returned 502 errors for the full 2-hour 10-minute outage window; no payments could be completed by any user during this period

---

## Timeline

All times are UTC.

| Time | Event |
|------|-------|
| 13:46 | AWS VPC Flow Logs show packet loss spike (8.4%) between `payment-service` subnet and `payment-db` subnet |
| 13:47 | TCP retransmission rate on `payment-db` network interface rises to 14% (baseline: <0.5%) |
| 13:48 | First payment error logged in `payment-service` (`connection pool exhausted`) |
| 13:51 | Error rate reaches 100%; all payment attempts failing |
| 13:52 | Automated Datadog alert fires: `payment.error_rate > 5%` |
| 13:52 | PagerDuty incident created (INC-2026-0089), routed to on-call engineer |
| 13:53 | AWS Health Dashboard shows "Degraded network connectivity" in us-east-1b AZ (same AZ as `payment-db`) |
| 14:37 | On-call engineer acknowledges incident in PagerDuty |
| 14:41 | On-call engineer begins investigation; checks `payment-service` logs |
| 14:45 | Slow query log identified in `payment-db` RDS instance |
| 14:52 | Database team (DBOPS) notified via Slack |
| 15:10 | DBOPS confirms query plan regression on `payment_records` table |
| 15:18 | AWS Health Dashboard marks us-east-1b network event as "Resolved" |
| 15:22 | Index rebuild initiated on `payment_records.user_id` |
| 15:44 | Index rebuild complete; query times return to normal |
| 15:58 | Connection pool recovers; payment success rate reaches 100% |
| 16:10 | Incident declared resolved; monitoring period begins |

---

## Root Cause Analysis

### Primary Root Cause

The root cause of this incident was database query performance degradation on the `payment_records` table. A routine autovacuum operation on the `payment_records` table caused the index statistics for the `idx_payment_records_user_id` index to be temporarily invalidated, causing the PostgreSQL query planner to select a sequential table scan instead of the index for queries filtering by `user_id`. The `payment_records` table contains approximately 47 million rows, making a full sequential scan take 8–12 seconds per query (compared to <5ms with the index). Under production load, the connection pool was exhausted within seconds of the planner regression beginning.

### Contributing Factors

1. **No query timeout configured:** The `payment-service` database client had no query timeout. Long-running queries held connections indefinitely rather than failing fast and freeing the pool.

2. **Connection pool too small:** The pool was configured with a maximum of 10 connections. Under normal load, this is sufficient, but a single slow query type can saturate the pool in seconds.

3. **Missing index health monitoring:** There is no existing monitor for query plan regressions or sequential scan frequency on high-traffic tables.

---

## What Went Well

- Automated alerting fired within 1 minute of the first errors
- The DBOPS team correctly identified the query plan regression quickly once engaged
- The index rebuild procedure resolved the issue cleanly with no data loss
- Post-resolution monitoring confirmed full recovery before the incident was closed

---

## What Went Poorly

- Response time from alert to acknowledgment was slow
- The initial investigation focused on the application layer before checking database metrics, adding delay to root cause identification
- No runbook existed for connection pool exhaustion, requiring ad-hoc troubleshooting
- Action items from a similar INC-2025-0312 database incident were not fully implemented before this recurrence

---

## Action Items

| # | Action | Owner | Due Date |
|---|--------|-------|----------|
| 1 | Improve monitoring | DBOPS | 2026-03-15 |
| 2 | Add more tests | Backend Platform | 2026-03-20 |
| 3 | Write runbook for connection pool exhaustion | Platform Engineering | 2026-03-10 |
| 4 | Improve on-call response | Engineering Management | 2026-03-31 |
| 5 | Fix database client configuration | Backend Platform | 2026-03-07 |
| 6 | Increase connection pool size | Backend Platform | 2026-03-07 |

---

## Detection Analysis

**Time to detect:** ~4 minutes (first error at 13:48, alert at 13:52)
**Time to acknowledge:** ~45 minutes (alert at 13:52, acknowledgment at 14:37)
**Time to mitigate:** ~2 hours 10 minutes (first error to resolution)

The automated detection was effective. The acknowledgment lag was the primary contributor to extended outage duration.

---

## Lessons Learned

1. **Database metrics should be in the initial incident investigation checklist.** The on-call engineer's initial focus on application logs delayed root cause identification by approximately 15 minutes. A structured investigation checklist would standardize the triage sequence.

2. **Connection pool configuration should be reviewed regularly.** The pool size was set 18 months ago when the table was much smaller. Capacity planning reviews should include database dependency assumptions.

3. **Runbooks accelerate resolution.** The DBOPS team's institutional knowledge about index rebuild procedures was essential, but it was not written down. If the database SME had been unavailable, resolution would have taken longer.

4. **Past action items must be tracked to completion.** INC-2025-0312 produced a similar recommendation to add query timeouts. That item was closed as "out of scope" in the follow-up sprint without implementation.

---

## Severity Classification Notes

The incident was classified as S2 (Major — significant service degradation with workaround available). This aligns with our severity matrix: S2 covers degradation affecting a major feature for a subset of users. During this incident, affected users could not complete payments but could attempt to retry after the outage was resolved.

---

## Appendix: Relevant Logs

### Connection Pool Exhaustion (payment-service)
```
2026-02-19T13:48:12Z ERROR [payment-service] Error: timeout acquiring connection from pool
  at Pool.connect (node_modules/pg-pool/index.js:98)
  at processPayment (src/payment-handler.ts:54)
  at POST /api/v1/payments (src/routes/payments.ts:22)
```

### Slow Query Log (payment-db RDS)
```
2026-02-19 13:47:58 UTC [12843]: LOG:  duration: 9241.382 ms  statement:
  SELECT id, user_id, amount_cents, currency, transaction_id, status, created_at
  FROM payment_records
  WHERE user_id = '3f8a1c92-...'
  ORDER BY created_at DESC LIMIT 100;
```

### Query Plan (showing sequential scan)
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... FROM payment_records WHERE user_id = '...';

Seq Scan on payment_records  (cost=0.00..1847234.00 rows=47 width=89)
                              (actual time=0.043..9198.441 rows=23 loops=1)
  Filter: (user_id = '3f8a1c92-...'::uuid)
  Rows Removed by Filter: 47018329
  Buffers: shared hit=412 read=1246788
Planning Time: 0.312 ms
Execution Time: 9198.623 ms
```

---

*Postmortem authored by Fatima Al-Hassan. Review meeting held 2026-02-26 with Platform Engineering and DBOPS teams present. This document is finalized and filed in Confluence under [Engineering > Incidents > 2026](https://internal.confluence/incidents/2026).*
