---
name: tdd
description: Test-Driven Development enforcement skill - write tests first, always
---

# TDD Mode

[TDD MODE ACTIVATED]

## The Iron Law

**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Write code before test? DELETE IT. Start over. No exceptions.

## Red-Green-Refactor Cycle

### 1. RED: Write Failing Test
- Write test for the NEXT piece of functionality
- Run test - MUST FAIL
- If it passes, your test is wrong

### 2. GREEN: Minimal Implementation
- Write ONLY enough code to pass the test
- No extras. No "while I'm here."
- Run test - MUST PASS

### 3. REFACTOR: Clean Up
- Improve code quality
- Run tests after EVERY change
- Must stay green

### 4. REPEAT
- Next failing test
- Continue cycle

## Enforcement Rules

| If You See | Action |
|------------|--------|
| Code written before test | STOP. Delete code. Write test first. |
| Test passes on first run | Test is wrong. Fix it to fail first. |
| Multiple features in one cycle | STOP. One test, one feature. |
| Skipping refactor | Go back. Clean up before next feature. |

## Commands

Before each implementation:
```bash
# Run the project's test command - should have ONE new failure
```

After implementation:
```bash
# Run the project's test command - new test should pass, all others still pass
```

## Output Format

When guiding TDD:

```
## TDD Cycle: [Feature Name]

### RED Phase
Test: [test code]
Expected failure: [what error you expect]
Actual: [run result showing failure]

### GREEN Phase
Implementation: [minimal code]
Result: [run result showing pass]

### REFACTOR Phase
Changes: [what was cleaned up]
Result: [tests still pass]
```

## External Model Consultation (Preferred)

The test-engineer agent SHOULD consult Codex for test strategy validation.

### Protocol
1. **Form your OWN test strategy FIRST** - Design tests independently
2. **Consult for validation** - Cross-check test coverage strategy
3. **Critically evaluate** - Never blindly adopt external suggestions
4. **Graceful fallback** - Never block if tools unavailable

### When to Consult
- Complex domain logic requiring comprehensive test coverage
- Edge case identification for critical paths
- Test architecture for large features
- Unfamiliar testing patterns

### When to Skip
- Simple unit tests
- Well-understood testing patterns
- Time-critical TDD cycles
- Small, isolated functionality

### Tool Usage
Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools.
Use `mcp__x__ask_codex` with `agent_role: "test-engineer"`.
If ToolSearch finds no MCP tools, fall back to the `test-engineer` Claude agent.

**Remember:** The discipline IS the value. Shortcuts destroy the benefit.
