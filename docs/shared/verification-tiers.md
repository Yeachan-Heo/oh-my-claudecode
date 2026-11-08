# Verification Tiers

Verification scales with task complexity to optimize cost while maintaining quality.

## Tier Definitions

| Tier | Criteria | Recommended Agent | Model | Evidence Required |
|------|----------|-------|-------|-------------------|
| **LIGHT** | <5 files, <100 lines, full test coverage | `architect` | haiku | lsp_diagnostics clean |
| **STANDARD** | Default (not LIGHT or THOROUGH) | `architect` | sonnet | diagnostics + build pass |
| **THOROUGH** | >20 files OR architectural/security changes | `architect` | opus | Full review + all tests |

## Verification Selection Logic

```
IF hasSecurityImplications OR hasArchitecturalChanges:
  → THOROUGH (always for security/architecture)
ELIF filesChanged > 20:
  → THOROUGH (large scope)
ELIF filesChanged < 5 AND linesChanged < 100 AND testCoverage === 'full':
  → LIGHT (small, well-tested)
ELSE:
  → STANDARD (default)
```

## Override Triggers

Keywords that influence tier selection:

| Keyword | Suggested Tier |
|---------|-------------|
| "thorough", "careful", "important", "critical" | THOROUGH |
| "quick", "simple", "trivial", "minor" | LIGHT |
| Security-related file changes | THOROUGH (always) |

## Architectural Change Detection

Path patterns that trigger architectural change detection:

- `**/config.{ts,js,json}`
- `**/schema.{ts,prisma,sql}`
- `**/definitions.ts`
- `**/types.ts`
- `package.json`
- `tsconfig.json`

Any changes to these files warrant THOROUGH verification.

## Security Implication Detection

Path patterns that trigger security concerns:

- `**/auth/**`
- `**/security/**`
- `**/permissions?.{ts,js}`
- `**/credentials?.{ts,js,json}`
- `**/secrets?.{ts,js,json,yml,yaml}`
- `**/tokens?.{ts,js,json}`
- `**/passwords?.{ts,js,json}`
- `**/oauth*`
- `**/jwt*`
- `**/.env*`

## Evidence Types

Required evidence for different claim types:

| Claim | Required Evidence |
|-------|-------------------|
| "Fixed" | Test showing it passes now |
| "Implemented" | lsp_diagnostics clean + build pass |
| "Refactored" | All tests still pass |
| "Debugged" | Root cause identified with file:line |

## Cost Comparison

| Tier | Typical Cost | Use Case |
|------|---|---|
| LIGHT | 1x | Single-file bug fixes with tests |
| STANDARD | 5x | Multi-file feature additions |
| THOROUGH | 20x | Major refactoring, security changes |

Estimated savings: ~40% reduction in verification costs by using tiered system vs. always using THOROUGH.

## Example Usage

When reviewing changes, use this pattern:

```bash
# Simple change (< 5 files, < 100 lines, full tests)
architect (model="haiku") "Verify these 2-line test fixes"

# Standard work (multi-file feature)
architect (model="sonnet") "Verify this feature implementation"

# Complex work (refactoring or security)
architect (model="opus") "Thoroughly review this security-critical refactoring"
```
