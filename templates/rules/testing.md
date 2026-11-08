# Testing Rules

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** - Individual functions, utilities, components
2. **Integration Tests** - API endpoints, database operations
3. **E2E Tests** - Critical user flows

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## Edge Cases to Test

Every function must be tested with:
- [ ] Null/undefined inputs
- [ ] Empty arrays/strings
- [ ] Invalid types
- [ ] Boundary values (min/max)
- [ ] Error conditions

## Test Quality Checklist

- [ ] Tests are independent (no shared state)
- [ ] Test names describe behavior
- [ ] Mocks used for external dependencies
- [ ] Both happy path and error paths tested
- [ ] No flaky tests

## [CUSTOMIZE] Project-Specific Testing

Add your project-specific testing requirements here:
- Test framework configuration
- Mock setup patterns
- E2E test scenarios
