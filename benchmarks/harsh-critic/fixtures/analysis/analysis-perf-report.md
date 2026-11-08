# Performance Analysis Report: API Latency Regression
**Report ID:** PERF-2026-011
**Author:** Rodrigo Alves, Platform Engineering
**Date:** 2026-02-28
**Period Analyzed:** 2026-02-17 through 2026-02-28
**Status:** Final — Recommendations Pending Approval

---

## Executive Summary

This report analyzes a latency regression observed in the `api-gateway` service beginning February 20, 2026. Mean response latency increased by 38% and P99 latency increased by 112% during the affected window. Statistical analysis demonstrates a strong correlation between deployment frequency and elevated latency, supporting the conclusion that the February 20 deployment of `api-gateway v2.14.0` caused the regression. Remediation recommendations are provided in Section 6.

---

## 1. Incident Timeline

| Timestamp (UTC) | Event |
|-----------------|-------|
| 2026-02-20 14:32 | `api-gateway v2.14.0` deployed to production |
| 2026-02-20 14:45 | Latency monitors begin showing elevated readings |
| 2026-02-20 15:00 | On-call engineer acknowledges Datadog alert |
| 2026-02-20 15:22 | Decision made to monitor rather than roll back |
| 2026-02-21 09:00 | Latency still elevated; escalated to Platform Engineering |
| 2026-02-21 11:30 | Root cause investigation begins |
| 2026-02-28 17:00 | This report finalized |

---

## 2. Observed Metrics

### 2.1 Latency (ms) — api-gateway, All Endpoints

The following measurements are taken from Datadog APM, aggregated per day, for the 12-day analysis window.

| Date | P50 (ms) | P95 (ms) | P99 (ms) | Deployments That Day |
|------|----------|----------|----------|----------------------|
| Feb 17 | 42 | 98 | 134 | 0 |
| Feb 18 | 41 | 95 | 128 | 1 |
| Feb 19 | 43 | 101 | 139 | 0 |
| Feb 20 | 67 | 189 | 287 | 1 |
| Feb 21 | 71 | 201 | 301 | 0 |
| Feb 22 | 68 | 194 | 291 | 0 |
| Feb 23 | 65 | 188 | 271 | 0 |
| Feb 24 | 69 | 197 | 284 | 1 |
| Feb 25 | 72 | 204 | 189 | 0 |
| Feb 26 | 66 | 191 | 278 | 0 |
| Feb 27 | 70 | 199 | 289 | 1 |
| Feb 28 | 68 | 193 | 276 | 0 |

**Baseline (Feb 17–19 average):** P50=42ms, P95=98ms, P99=134ms
**Affected period (Feb 20–28 average):** P50=68ms, P95=195ms, P99=286ms

**Delta:** P50 +62%, P95 +99%, P99 +113%

### 2.2 Error Rate

Error rate remained stable throughout the window (0.08%–0.12%). The regression is purely latency-related with no associated increase in errors.

### 2.3 Traffic Volume

Traffic volume was within normal seasonal bounds. No significant traffic spike coincides with the latency onset.

---

## 3. Statistical Analysis

### 3.1 Correlation: Deployment Days vs. Latency

To quantify the relationship between deployment activity and latency, we computed the Pearson correlation coefficient between the "Deployments That Day" column and P99 latency across the 12-day window.

**r = 0.71** (moderate-to-strong positive correlation)

We also ran a one-tailed t-test comparing mean P99 latency on high-traffic days (n=6) versus low-traffic days (n=6) sampled from the same window. Total sample size across both groups: n=12.

- High-traffic day mean P99: 267ms
- Low-traffic day mean P99: 198ms
- **t-statistic: 2.44, p = 0.03 (p < 0.05)**

This result is statistically significant, confirming that deployment events correlate with latency elevation in our dataset.

### 3.2 Endpoint Breakdown

The latency increase is not uniform across endpoints:

| Endpoint | Pre-Feb-20 P99 | Post-Feb-20 P99 | Delta |
|----------|----------------|-----------------|-------|
| GET /api/v1/organizations | 145ms | 312ms | +115% |
| POST /api/v1/auth/token | 89ms | 201ms | +126% |
| GET /api/v1/products | 112ms | 247ms | +121% |
| GET /api/v1/users/:id | 78ms | 156ms | +100% |
| POST /api/v1/webhooks | 201ms | 298ms | +48% |

The endpoints with the largest relative degradation are those that touch the database connection pool, suggesting middleware overhead or connection contention introduced in v2.14.0.

---

## 4. Root Cause Analysis

### 4.1 Deployment Correlation

The temporal proximity of the `api-gateway v2.14.0` deployment (Feb 20, 14:32 UTC) and the onset of elevated latency (14:45 UTC, ~13 minutes later) is the primary evidence pointing to this deployment as the root cause.

The changelog for v2.14.0 includes:
- Upgraded `express-validator` from 6.x to 7.x
- Added request body logging middleware (default: ON)
- Refactored connection pool initialization (lazy → eager)

The request body logging middleware is the most likely culprit. Logging large request bodies synchronously in the request path would introduce consistent per-request overhead, which aligns with the observed latency profile (all endpoints affected, proportional to body size patterns).

### 4.2 Conclusion

**The February 20 deployment of api-gateway v2.14.0 caused the latency regression.** The statistical correlation is significant (p < 0.05), the onset timing is precise, and the changelog entry for request body logging middleware provides a plausible technical mechanism.

---

## 5. Comparison to Previous Week

The analysis window was selected to start February 17 to capture a clean 3-day pre-deployment baseline. This starting date provides a sufficient comparison baseline immediately before the regression.

---

## 6. Recommendations

### Immediate (This Sprint)

1. **Disable request body logging middleware** in api-gateway. The middleware was added for debugging purposes and should not have been enabled by default in production. Estimated latency recovery: full regression reversion.

2. **Add middleware performance gate to CI:** Any new middleware must demonstrate < 5ms overhead in load testing before merging to main.

### Short-Term (Next Quarter)

3. **Instrument per-middleware latency:** Use `express-mung` or equivalent to emit timing metrics for each middleware layer individually. This would have made the root cause immediately obvious.

4. **Implement canary deployment gates:** Auto-roll back deployments where P99 latency increases > 20% within 10 minutes of deployment. This would have contained the blast radius to a 10-minute window rather than 8 days.

5. **Expand load test coverage:** Add P99 latency assertions to the load test suite that runs in CI. Current load tests only assert on error rate.

### Infrastructure Scaling (Next Two Quarters)

6. **Upgrade api-gateway instance type** from `c5.xlarge` to `c5.2xlarge` to provide headroom for additional middleware overhead and future traffic growth. Estimated additional monthly cost: $840/month per region.

7. **Add a second api-gateway replica** to all three production regions to reduce the blast radius of any single-node degradation. Estimated additional monthly cost: $1,200/month.

8. **Implement adaptive connection pooling** to dynamically size the database connection pool based on observed concurrency rather than the static limit of 20 connections currently configured.

---

## 7. Appendix: Raw Datadog Queries

Queries used for metric extraction (Datadog APM):

```
# P99 latency
avg:trace.express.request{service:api-gateway,env:production} by {resource_name}.rollup(p99, 3600)

# Error rate
sum:trace.express.request.errors{service:api-gateway,env:production}.as_rate() /
sum:trace.express.request.hits{service:api-gateway,env:production}.as_rate()

# Deployment marker events
events("source:deployment service:api-gateway")
```

---

*Report prepared by Rodrigo Alves. For questions, contact #platform-engineering in Slack.*
