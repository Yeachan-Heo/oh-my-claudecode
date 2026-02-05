# Escalation Protocol

## When to Escalate

Escalation happens when a lower-tier agent encounters complexity beyond its scope:

### LOW to MEDIUM Triggers

- More than 5 files need analysis
- Task requires cross-module understanding
- Non-trivial debugging or refactoring
- External API/library knowledge needed

### MEDIUM to HIGH Triggers

- Architectural decisions with system-wide impact
- Complex multi-file refactoring
- Security-critical code changes
- Performance optimization requiring deep analysis
- Root cause analysis of subtle bugs

## How to Report for Escalation

When you determine escalation is needed:

1. Complete what you can at your tier
2. Document what you found so far
3. Clearly state WHY escalation is needed
4. Identify the specific complexity that exceeds your tier
