# API Layer Refactor Plan
**Version:** 2.1
**Owner:** Backend Platform Team
**Last Updated:** 2026-02-25
**Target Completion:** 2026-04-11
**Status:** Approved — Starting Week of March 9

---

## Executive Summary

This plan describes a comprehensive refactor of our REST API layer to address accumulated technical debt, improve consistency, and prepare the codebase for our Q2 public API launch. The refactor involves restructuring the route definition files, standardizing error response formats, migrating to OpenAPI-first development, and upgrading our data models to reflect the current domain language.

The primary deliverable is a cleaner, more maintainable API layer that is consistent enough to expose publicly without embarrassment.

---

## Motivation

The API layer has grown organically over three years and now has several systemic problems:

1. **Route organization:** Routes are scattered across feature directories with no coherent grouping strategy. Some endpoints live in controller files, others in middleware, others in inline `app.use()` calls.

2. **Inconsistent error formats:** Endpoints return either `{ "error": "..." }` or `{ "message": "..." }` based on which developer wrote them. Some return both. Consumers cannot reliably handle errors programmatically.

3. **Stale model names:** Internal model names from the 2023 domain redesign were never reflected in API surface. The API still uses `Account` where the domain model now uses `Organization`, `Item` where the domain uses `Product`, etc.

4. **No versioning strategy:** We have been making breaking changes directly to the current API without a versioning contract. The upcoming public launch requires a stable v1 baseline before we can ship v2 features.

5. **Auth middleware fragmentation:** There are currently four different auth middleware implementations across the codebase, each with slightly different behavior around token validation and error responses.

---

## Scope

### In Scope
- Route file consolidation and reorganization
- Error response format standardization
- Model rename (Account → Organization, Item → Product, Ledger → Invoice)
- API versioning implementation (v1 prefix for all current routes)
- Auth middleware consolidation to single implementation
- OpenAPI specification generation from route definitions

### Out of Scope
- Business logic changes within controllers
- Database schema changes (separate plan, Q3)
- Frontend changes (frontend team owns client-side updates)
- GraphQL layer (separate initiative)

---

## Current State

### Route File Structure (Current)
```
src/
  api/
    routes.ts          ← primary route definitions (458 lines)
    middleware/
      auth.ts          ← primary auth middleware
      rateLimiter.ts
      cors.ts
    controllers/
      users.ts
      accounts.ts
      billing.ts
  features/
    search/
      routes.ts        ← search-specific routes (duplicates some from src/api/routes.ts)
    export/
      routes.ts        ← export routes
```

### Error Response Examples (Current — Inconsistent)
```json
// From users.ts
{ "error": "User not found" }

// From billing.ts
{ "message": "Payment method invalid", "code": "PAYMENT_INVALID" }

// From accounts.ts
{ "error": "Unauthorized", "message": "Token expired" }
```

---

## Target State

### Route File Structure (Target)
```
src/
  routes/
    api.ts             ← unified route registry (all v1 routes)
    index.ts           ← mounts versioned route trees
  middleware/
    auth.ts            ← single consolidated auth middleware
    rateLimiter.ts
    cors.ts
    errorHandler.ts    ← centralized error formatting
  controllers/
    organizations.ts   ← renamed from accounts.ts
    products.ts        ← renamed from items.ts
    invoices.ts        ← renamed from ledger.ts
    users.ts
    billing.ts
```

### Error Response Standard (Target)
All endpoints must return errors in this format:
```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable description",
    "details": {}  // optional, for validation errors
  }
}
```

---

## Refactor Tasks

### Task 1 — Audit and Document Current Routes (Week 1)
**Owner:** @backend-platform
**Estimated effort:** 2 days

Generate a complete inventory of all existing routes, their current paths, auth requirements, and response formats. Output: `docs/api-audit-2026-03.md`.

Tools: `ts-morph` static analysis + manual review of `src/api/routes.ts`.

**Acceptance criteria:**
- All routes documented with path, method, controller, auth requirement
- Inconsistencies flagged with specific file references

---

### Task 2 — Implement Centralized Error Handler (Week 1)
**Owner:** @backend-platform
**Estimated effort:** 1 day

Create `src/middleware/errorHandler.ts` implementing the standardized error response format. This handler is registered as the last middleware in the Express stack. All controllers are updated to throw typed errors rather than formatting responses inline.

Error type hierarchy:
```typescript
class ApiError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number,
    public details?: Record<string, unknown>
  ) { super(message); }
}

class NotFoundError extends ApiError { /* ... */ }
class UnauthorizedError extends ApiError { /* ... */ }
class ValidationError extends ApiError { /* ... */ }
```

**Acceptance criteria:**
- All test endpoints return errors in the new format
- Existing controllers throw typed errors (no inline `res.status(400).json(...)`)

---

### Task 3 — Consolidate Auth Middleware (Week 2)
**Owner:** @backend-platform, @security
**Estimated effort:** 2 days

Deprecate the three non-canonical auth middleware implementations:
- `src/features/search/middleware/auth.ts` (custom, lacks token refresh)
- `src/features/export/middleware/auth.ts` (does not validate `exp` claim)
- `src/api/middleware/legacyAuth.ts` (cookie-based, for legacy clients)

The canonical `src/api/middleware/auth.ts` will be updated to handle all token types. Once this task is marked complete, the deprecated files are deleted.

**Note:** During this transition period while the legacy auth files exist alongside the new consolidated middleware, certain service routes will not have any auth middleware applied. This is an expected consequence of the incremental migration and will be resolved when the deprecated files are removed in the following step.

**Acceptance criteria:**
- Single auth middleware file passes all existing auth tests
- No other auth middleware files exist in the repo
- `grep -r "legacyAuth\|features/.*middleware/auth"` returns no matches

---

### Task 4 — Rename Models and Update Routes (Week 2–3)
**Owner:** @backend-platform
**Estimated effort:** 3 days

Rename domain models throughout the API layer:

| Old Name | New Name | Affected Files |
|----------|----------|----------------|
| `Account` | `Organization` | controllers/accounts.ts → controllers/organizations.ts |
| `Item` | `Product` | controllers/items.ts → controllers/products.ts |
| `Ledger` | `Invoice` | controllers/ledger.ts → controllers/invoices.ts |

Route path updates:
- `/api/accounts/*` → `/api/v1/organizations/*`
- `/api/items/*` → `/api/v1/products/*`
- `/api/ledger/*` → `/api/v1/invoices/*`

Old paths will return `301 Moved Permanently` for 90 days before removal.

**Acceptance criteria:**
- New route paths return correct responses
- Old route paths return 301 redirects to new paths
- Model type names updated in all TypeScript interfaces

---

### Task 5 — Consolidate Route Definitions (Week 3)
**Owner:** @backend-platform
**Estimated effort:** 2 days

Move all route definitions to `src/routes/api.ts`. Remove scattered route definitions from feature directories. Register all v1 routes under the `/api/v1` prefix.

The `src/routes/index.ts` file mounts the versioned route trees:
```typescript
app.use('/api/v1', v1Routes);
// Future: app.use('/api/v2', v2Routes);
```

**Acceptance criteria:**
- All routes accessible under `/api/v1/*`
- No route definitions exist outside `src/routes/`
- Route inventory from Task 1 fully reconciled

---

### Task 6 — Generate OpenAPI Specification (Week 4)
**Owner:** @backend-platform, @docs
**Estimated effort:** 2 days

Use `tsoa` to generate an OpenAPI 3.1 specification from route definitions and TypeScript types. Output: `docs/openapi.yaml`. CI check ensures spec stays in sync with code.

```yaml
# .github/workflows/api-spec.yml
- name: Validate OpenAPI spec
  run: npm run generate:openapi && git diff --exit-code docs/openapi.yaml
```

**Acceptance criteria:**
- `docs/openapi.yaml` generated and checked into repo
- CI fails if spec is out of date
- All v1 endpoints documented with request/response schemas

---

### Task 7 — Update Internal Consumers (Week 4)
**Owner:** @backend-platform, @service-owners
**Estimated effort:** 3 days

Internal services that call our API directly (bypassing the API gateway) need to be updated to use the new v1 paths and the new error format. Known internal consumers:

- `analytics-ingestion`: calls `/api/accounts/:id` → update to `/api/v1/organizations/:id`
- `billing-service`: calls `/api/ledger/:id` → update to `/api/v1/invoices/:id`
- `admin-panel`: calls various `/api/items/*` → update to `/api/v1/products/*`

**Acceptance criteria:**
- All internal consumers updated and passing integration tests
- No calls to deprecated paths in internal service logs

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| External clients break on path changes | High | High | 301 redirects for 90 days; customer communication |
| Model rename misses an occurrence | Medium | Medium | TypeScript compiler catches type mismatches; grep validation |
| Auth middleware consolidation introduces regression | Medium | High | Full auth integration test suite run before merge |
| OpenAPI spec generation fails on complex types | Low | Low | Manual spec for complex endpoints as fallback |

---

## Testing Strategy

All refactored routes must pass:

1. **Existing integration test suite** — no regressions allowed
2. **Error format validation tests** — new test suite verifying all error responses match the schema
3. **Auth middleware tests** — verify consolidated middleware handles all token types
4. **Redirect tests** — verify old paths return 301 with correct `Location` header

---

## Timeline

| Week | Milestone |
|------|-----------|
| Week 1 (Mar 9) | Task 1 audit complete; Task 2 error handler merged |
| Week 2 (Mar 16) | Task 3 auth consolidation; Task 4 model renames begin |
| Week 3 (Mar 23) | Task 4 complete; Task 5 route consolidation |
| Week 4 (Mar 30) | Task 6 OpenAPI spec; Task 7 internal consumers |
| Week 5 (Apr 7) | Final QA, staging validation, production cutover |

---

## Approvals

| Role | Name | Date |
|------|------|------|
| Engineering Lead | Tomás Ferreira | 2026-02-20 |
| Security Review | Yuki Tanaka | 2026-02-22 |
| API Consumer Rep | Dev Relations | 2026-02-24 |
| Product | Sandra Obi | 2026-02-25 |
