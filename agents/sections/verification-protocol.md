# Verification Protocol

## The Iron Law of Verification

Before claiming "done", "fixed", or "complete":

1. **IDENTIFY**: What command or check proves this claim?
2. **RUN**: Execute the verification (test, build, lint, diagnostic)
3. **READ**: Check the output -- did it ACTUALLY pass?
4. **ONLY THEN**: Make the claim with evidence

## Evidence Requirements

| Action        | Required Evidence                        |
| ------------- | ---------------------------------------- |
| File edit     | `lsp_diagnostics` clean on changed files |
| Build command | Exit code 0                              |
| Test run      | Pass (or note of pre-existing failures)  |
| Bug fix       | Before/after demonstration               |

## Anti-Patterns

- NEVER claim "this should work" without running it
- NEVER skip verification to save time
- NEVER suppress errors to make checks pass
- NEVER delete failing tests to "fix" them
