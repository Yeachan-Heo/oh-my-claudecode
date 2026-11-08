# Auth System Migration Plan
**Version:** 1.4
**Owner:** Platform Security Team
**Last Updated:** 2026-02-18
**Target Completion:** 2026-03-28
**Status:** Approved — Implementation In Progress

---

## Executive Summary

This plan documents the migration of our authentication system from the legacy session-cookie model to a stateless JWT-based architecture. The primary drivers are scalability (eliminating server-side session storage), support for our upcoming mobile SDK, and alignment with our company-wide RBAC model. The migration affects ~14 services and approximately 2.4 million active user accounts.

---

## Background

Our current authentication relies on server-side session storage backed by Redis. As we expand to a multi-region deployment model, session replication has become a significant operational burden. The new JWT-based system will allow each service to validate tokens independently without a shared session store, reducing inter-service latency and eliminating a single point of failure.

---

## Goals

1. Replace server-side session storage with signed JWTs
2. Introduce short-lived access tokens (15 min) with refresh token rotation
3. Integrate with the existing RBAC model for role claims in token payload
4. Support third-party OAuth providers (Google, GitHub) via the new `/auth/oauth/callback` endpoint
5. Reduce auth-related Redis calls by 90%

---

## Non-Goals

- Changing the RBAC model itself (roles and permissions stay unchanged)
- Migrating non-human service accounts (handled separately in Q3)
- Updating mobile clients (mobile team owns that work stream)

---

## Architecture Overview

### Token Structure

```
Header: { alg: "RS256", typ: "JWT" }
Payload: {
  sub: "<userId>",
  roles: ["<role1>", "<role2>"],
  permissions: ["<perm1>"],
  iat: <issued-at>,
  exp: <expiry>,
  jti: "<unique-token-id>"
}
Signature: RS256(header + payload, PRIVATE_KEY)
```

Tokens are signed with RS256. Public keys are distributed via the `/.well-known/jwks.json` endpoint.

### Token Lifecycle

- **Access token TTL:** 15 minutes
- **Refresh token TTL:** 7 days (sliding)
- **Refresh token storage:** Postgres table `refresh_tokens` with indexed `user_id` and `token_hash` columns

---

## Migration Tasks

### Task 1 — Deploy New Auth Service (Week 1)
**Owner:** @platform-security
**Estimated effort:** 3 days

Deploy `auth-service-v2` alongside the existing `auth-service-v1`. The new service exposes:
- `POST /auth/token` — issue JWT pair
- `POST /auth/refresh` — rotate refresh token
- `POST /auth/logout` — invalidate refresh token
- `GET  /.well-known/jwks.json` — public key distribution

The service will call `validateSession()` on the legacy session store during the dual-write phase to ensure backward compatibility while both systems run in parallel. This call is used to verify that an active legacy session exists before issuing a new JWT, preventing token issuance for already-invalidated sessions.

Environment configuration is in `config/auth-service-v2.yaml`. Secrets are provisioned via Vault at path `secret/auth-service-v2/`.

**Acceptance criteria:**
- New service passes all integration tests in `test/auth-service-v2/`
- JWKS endpoint returns valid key set
- Load test shows < 50ms p99 response time for `/auth/token`

---

### Task 2 — Database Schema Migration (Week 1–2)
**Owner:** @data-platform
**Estimated effort:** 2 days

Apply the following schema changes to the `auth` database:

```sql
-- Add new columns
ALTER TABLE users ADD COLUMN password_hash_v2 VARCHAR(255);
ALTER TABLE users ADD COLUMN mfa_secret_encrypted TEXT;

-- Add refresh tokens table
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE(token_hash)
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Drop legacy session columns (after dual-write phase completes)
ALTER TABLE users DROP COLUMN session_token;
ALTER TABLE users DROP COLUMN session_expires_at;
```

These migrations will be run via our standard Flyway pipeline. Migration scripts are located in `db/migrations/auth/V2026_02__jwt_migration.sql`.

**Acceptance criteria:**
- Migration runs cleanly in staging with no data loss
- Rollback script (`V2026_02__jwt_migration_rollback.sql`) verified in staging

---

### Task 3 — Dual-Write Phase (Week 2–3)
**Owner:** @platform-security
**Estimated effort:** 4 days

During this phase, all new logins issue both a legacy session cookie and a new JWT pair. Existing sessions remain valid. Traffic is routed based on a feature flag `auth.jwt_enabled` (managed in LaunchDarkly):

- Flag OFF (default): legacy session auth
- Flag ON (10% rollout → 50% → 100%): JWT auth

Client SDKs detect the presence of the `Authorization: Bearer` header and use the JWT path. Clients without the updated SDK continue on the cookie path.

---

### Task 4 — Update Downstream Services (Week 3–4)
**Owner:** @platform-security, @service-owners
**Estimated effort:** 5 days

Update all 14 downstream services to validate JWTs using the shared `auth-middleware` package. This package is published after Task 6 completes the public key infrastructure setup, so service updates must wait for Task 6 to finish.

Services to update (in dependency order):
1. `api-gateway` — primary entry point
2. `user-service` — profile management
3. `billing-service` — payment and subscription
4. `notification-service` — email/push dispatch
5. `admin-panel` — internal tooling
6. `analytics-ingestion` — event pipeline
7. `search-service` — Elasticsearch proxy
8. `export-service` — async job runner

Each service update requires:
- Replacing `legacy-auth-middleware` with `auth-middleware@^2.0`
- Updating environment config to point to `JWKS_URL`
- Running the service's auth integration tests

**Acceptance criteria:**
- All 14 services pass their integration test suites
- No auth errors in staging traffic replay

---

### Task 5 — Cutover and Legacy Decommission (Week 4–5)
**Owner:** @platform-security
**Estimated effort:** 2 days

Flip the `auth.jwt_enabled` flag to 100%. Monitor error rates for 24 hours. After a clean 24-hour window:

1. Disable the legacy `/auth/login` endpoint
2. Delete the `auth-service-v1` deployment
3. Remove `legacy-auth-middleware` from all services
4. Archive the Redis session store (retain data for 90 days for audit)

**Acceptance criteria:**
- Auth error rate < 0.1% for 24 hours post-cutover
- Legacy service has zero traffic for 1 hour before teardown

---

### Task 6 — Public Key Infrastructure (Week 2)
**Owner:** @platform-security
**Estimated effort:** 2 days

Generate RSA-2048 key pairs for token signing. Store private key in Vault at `secret/auth-service-v2/signing-key`. Expose public keys via `/.well-known/jwks.json` with a 1-hour cache TTL.

Key rollover procedure: new key pairs are added to the JWKS endpoint 24 hours before they become active. Old keys remain in the JWKS for 48 hours after retirement to allow in-flight tokens to validate.

**Note:** This task must complete before Task 4 can begin, as downstream services require the JWKS URL to be stable.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| JWT library vulnerability discovered | Low | High | Pin library versions; subscribe to security advisories |
| Clock skew causing token rejection | Medium | Medium | Allow 30-second leeway in token validation |
| Feature flag misconfiguration | Low | High | Test flag behavior in staging before production rollout |
| Redis session store unavailable during dual-write | Low | Medium | Graceful fallback: issue JWT without legacy session check |
| Increased latency from JWKS fetch | Medium | Low | Cache JWKS aggressively; use background refresh |

---

## Testing Plan

### Unit Tests
- Token issuance and validation logic
- Refresh token rotation
- Token revocation (logout)
- RBAC claims extraction from token payload

### Integration Tests
- End-to-end login → token issuance → protected resource access
- Refresh token rotation under concurrent requests
- Token expiry and re-authentication flow

### Staging Validation
- Full regression suite against staging environment
- 48-hour canary with 5% of staging traffic on JWT path

---

## Naming Conventions

All new code uses the following naming standards:
- HTTP header: `Authorization: Bearer <authToken>`
- Database column: `token_hash`
- SDK method: `getAuthToken()` / `refreshAuthToken()`
- Internal variable naming: use `accessToken` in all new service code

Existing code in `legacy-auth-middleware` uses `authToken` in some places. Do not introduce new uses of `authToken` in new code; prefer `accessToken` throughout.

---

## Dependencies

| Dependency | Version | Owner |
|------------|---------|-------|
| `jsonwebtoken` | ^9.0 | npm |
| `jwks-rsa` | ^3.1 | npm |
| `auth-middleware` | ^2.0 | @platform-security |
| Vault | 1.15 | @infra |
| LaunchDarkly | current | @platform |

---

## Approvals

| Role | Name | Date |
|------|------|------|
| Engineering Lead | Sarah Chen | 2026-02-14 |
| Security Review | Andrei Volkov | 2026-02-15 |
| Data Platform | Marcus Webb | 2026-02-17 |
| Product | Priya Nair | 2026-02-18 |
