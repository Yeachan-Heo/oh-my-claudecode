# Notifications Service Deployment Plan
**Version:** 1.0
**Owner:** Growth Engineering Team
**Last Updated:** 2026-02-27
**Target Completion:** 2026-03-21
**Status:** Approved

---

## Executive Summary

This plan covers the deployment of a new Notifications Service that consolidates email, push, and in-app notifications into a single managed service. Currently, notification logic is duplicated across four services (user-service, billing-service, marketing-service, and order-service), leading to inconsistent formatting, duplicate sends, and difficult debugging. The new service provides a single, reliable delivery layer with observability built in.

The rollout is low-risk: the notifications service is additive (no existing functionality is removed in this phase), and all sends are gated behind a feature flag.

---

## Background

### Current State

Each of the four origin services calls email/push providers directly:

- **user-service** — welcome emails, password reset, email verification
- **billing-service** — invoice emails, payment failure alerts
- **marketing-service** — promotional campaigns (3rd-party ESP integration)
- **order-service** — order confirmation, shipping updates, delivery confirmation

This fragmentation has caused recurring incidents:
- Duplicate welcome emails when user-service retries on network timeout (2x in Q4 2025)
- Payment failure alerts silently dropped when billing-service's SendGrid API key expired
- No unified log of what notifications a user has received

### Target State

A dedicated `notifications-service` owns all notification delivery. Origin services publish events to an SQS queue; the notifications service consumes, templates, deduplicates, and delivers them. Event producers are decoupled from delivery mechanics.

---

## Architecture

### Components

```
Origin Services → SQS Queue → notifications-service → Providers
                                      ↓
                               PostgreSQL (audit log)
                               Redis (deduplication)
```

**notifications-service** responsibilities:
- Consume events from `notifications-queue` (SQS FIFO)
- Resolve template for event type + user locale
- Check deduplication window (Redis, 24h TTL keyed on `{userId}:{eventType}:{dedupKey}`)
- Deliver via appropriate provider (SendGrid for email, Firebase for push, internal WebSocket for in-app)
- Write delivery record to `notification_log` table (Postgres)
- Emit metrics to Datadog on delivery success/failure/dedup-skip

### Message Schema

```json
{
  "eventType": "user.password_reset",
  "userId": "uuid",
  "dedupKey": "optional-caller-provided-key",
  "templateVariables": { "resetLink": "..." },
  "channels": ["email"],
  "priority": "high"
}
```

### File References

- Service source: `src/services/notifications/`
- Queue configuration: `infrastructure/sqs/notifications-queue.tf`
- Database migrations: `db/migrations/notifications/V2026_03__notification_log.sql`
- Helm chart: `deploy/helm/notifications-service/`
- Feature flag: `notifications.service_enabled` (LaunchDarkly)

---

## Deployment Tasks

### Task 1 — Infrastructure Provisioning (Week 1)
**Owner:** @infra
**Estimated effort:** 1 day

Provision:
- SQS FIFO queue `notifications-queue` with dead-letter queue `notifications-dlq` (maxReceiveCount: 3)
- Redis ElastiCache cluster `notifications-cache` (t3.medium, single-AZ for staging; multi-AZ for prod)
- Postgres table via migration `V2026_03__notification_log.sql`
- IAM roles granting notifications-service read access to `notifications-queue` and write to CloudWatch

Staging environment is provisioned first. Production infrastructure is not created until staging validation is complete (Task 4).

**Acceptance criteria:**
- `terraform plan` produces expected output with zero destructive changes
- SQS queue reachable from notifications-service staging pod
- Database migration runs cleanly with no errors

---

### Task 2 — Deploy notifications-service to Staging (Week 1–2)
**Owner:** @growth-eng
**Estimated effort:** 2 days

Deploy `notifications-service:v1.0.0` to the staging Kubernetes cluster using the Helm chart at `deploy/helm/notifications-service/`. Configuration is provided via sealed secrets and a `values-staging.yaml` override.

The service starts with the feature flag `notifications.service_enabled` set to OFF. No traffic is routed to it until Task 3.

**Acceptance criteria:**
- Pod passes readiness and liveness probes
- `/healthz` returns 200 with all dependency checks green (SQS reachability, Postgres connectivity, Redis ping)
- Service logs appear in Datadog log stream

---

### Task 3 — Staging Integration Testing (Week 2)
**Owner:** @growth-eng, @qa
**Estimated effort:** 2 days

Enable the feature flag for the staging environment and run the full integration test suite:

```bash
npm run test:integration -- --suite notifications --env staging
```

Test coverage includes:
- End-to-end: event published to SQS → email delivered to SendGrid sandbox → delivery record in DB
- Deduplication: same event within 24h window triggers only one delivery
- Dead-letter: malformed message lands in DLQ, alert fires in Datadog
- Locale routing: `templateVariables` with `locale: "es"` resolves Spanish template
- Priority handling: `priority: "high"` events are processed before standard queue depth

**Acceptance criteria:**
- All 47 integration tests pass
- Zero unexpected errors in service logs during test run
- Datadog dashboard shows correct metrics (delivery count, dedup count, DLQ depth)

---

### Task 4 — Gradual Production Rollout (Week 3)
**Owner:** @growth-eng
**Estimated effort:** 1 day (plus monitoring)

Production rollout uses a phased flag rollout:

| Time | Flag % | Monitoring Action |
|------|--------|-------------------|
| T+0h | 5% | Watch error rate, DLQ depth, p99 delivery latency |
| T+4h | 25% | Confirm metrics within SLO; proceed if clean |
| T+12h | 75% | Full review of delivery audit log; spot-check 20 users |
| T+24h | 100% | Rollout complete; begin Task 5 |

**Rollback procedure:** If error rate exceeds 1% or DLQ depth exceeds 10 messages at any stage, set flag to 0% immediately. The DLQ messages will be replayed once the issue is resolved. No data loss occurs because origin services continue to publish events to SQS regardless of flag state; the events queue until the service recovers.

**Acceptance criteria:**
- 100% rollout reached with no incidents
- p99 delivery latency < 5s for email, < 2s for push
- Zero duplicate notifications confirmed via audit log spot-check

---

### Task 5 — Monitoring and Alerting Finalization (Week 3)
**Owner:** @growth-eng, @infra
**Estimated effort:** 1 day

Ensure production monitoring is complete:

- **Datadog monitors:**
  - `notifications.delivery_error_rate > 1%` → PagerDuty P2
  - `notifications.dlq_depth > 5` → PagerDuty P2
  - `notifications.p99_latency_email > 10s` → PagerDuty P3 (Slack)
  - `notifications.service_up == false` → PagerDuty P1

- **Runbook:** `docs/runbooks/notifications-service.md` covers:
  - How to replay DLQ messages
  - How to identify a user's full notification history
  - How to disable a specific notification type via feature flag
  - On-call escalation path

**Acceptance criteria:**
- All Datadog monitors in green state after 24h of 100% traffic
- Runbook reviewed and approved by on-call rotation lead

---

## Rollback Plan

The notifications service is purely additive in Phase 1. Rollback is achieved by setting the feature flag `notifications.service_enabled` to 0%. Origin services do not need to be modified; they continue publishing events to SQS. No database rollback is required because the `notification_log` table is append-only and does not affect any other service.

If the SQS queue accumulates a backlog during an outage, messages will be processed automatically when the service recovers. Messages older than the 4-day SQS message retention window will be lost; this is acceptable for notification use cases.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SendGrid API key rotation disrupts delivery | Low | Medium | Secrets managed via Vault with automated rotation; health check validates key on startup |
| SQS consumer falls behind under load | Medium | Low | Auto-scaling configured; DLQ alert fires before messages expire |
| Template rendering error causes DLQ flood | Low | Medium | Template validation CI step; DLQ alert fires within 5 minutes |
| Redis unavailable (dedup bypass) | Low | Low | Dedup is best-effort; service delivers without dedup check if Redis is down; alert fires |

---

## Dependencies

| Dependency | Version / Config | Owner |
|------------|-----------------|-------|
| `notifications-service` image | v1.0.0 | @growth-eng |
| SendGrid API | v3 | @growth-eng (key in Vault) |
| Firebase Admin SDK | 12.x | @growth-eng |
| LaunchDarkly flag `notifications.service_enabled` | Created | @platform |
| SQS queue `notifications-queue` | FIFO | @infra |
| Postgres migration `V2026_03__notification_log.sql` | Applied in staging | @data-platform |

---

## Stakeholder Sign-Off

| Role | Name | Date |
|------|------|------|
| Engineering Lead | Chloe Park | 2026-02-24 |
| SRE / On-Call Lead | Darius Mensah | 2026-02-25 |
| Security Review | Elena Sorokina | 2026-02-26 |
| Product | James Okafor | 2026-02-27 |
