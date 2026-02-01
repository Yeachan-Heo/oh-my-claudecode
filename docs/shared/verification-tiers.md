# Verification Tiers

Verification scales with task complexity to optimize cost while maintaining quality.

## Tier Definitions

| Tier | Criteria | Agent | Model | Evidence Required |
|------|----------|-------|-------|-------------------|
| **LIGHT** | <5 files, <100 lines, full test coverage | architect-low | haiku | lsp_diagnostics clean |
| **STANDARD** | Default (not LIGHT or THOROUGH) | architect-medium | sonnet | diagnostics + build pass |
| **THOROUGH** | >20 files OR architectural/security changes | architect | opus | Full review + all tests |

## Selection Interface

```typescript
interface ChangeMetadata {
  filesChanged: number;
  linesChanged: number;
  hasArchitecturalChanges: boolean;
  hasSecurityImplications: boolean;
  testCoverage: 'none' | 'partial' | 'full';
}

type VerificationTier = 'LIGHT' | 'STANDARD' | 'THOROUGH';
```

## Selection Logic

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

User keywords that override auto-detection:

| Keyword | Forces Tier |
|---------|-------------|
| "thorough", "careful", "important", "critical" | THOROUGH |
| "quick", "simple", "trivial", "minor" | LIGHT |
| Security-related file changes | THOROUGH (always) |

## Architectural Change Detection

Files that trigger `hasArchitecturalChanges`:
- `**/config.{ts,js,json}`
- `**/schema.{ts,prisma,sql}`
- `**/definitions.ts`
- `**/types.ts`
- `package.json`
- `tsconfig.json`

## Security Implication Detection

Path patterns that trigger `hasSecurityImplications`:
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

| Tier | Relative Cost | Use Case |
|------|---------------|----------|
| LIGHT | 1x | Single-file bug fixes with tests |
| STANDARD | 5x | Multi-file feature additions |
| THOROUGH | 20x | Major refactoring, security changes |

Estimated savings: ~40% reduction in verification costs by using tiered system vs. always using THOROUGH.

## Usage in Modes

All persistence modes (ralph, autopilot, ultrapilot) should use the tier-selector before spawning verification agents:

```typescript
import { selectVerificationTier, getVerificationAgent } from '../verification/tier-selector';

const tier = selectVerificationTier(changeMetadata);
const { agent, model } = getVerificationAgent(tier);

// Spawn appropriate verification agent
Task(subagent_type=`oh-my-claudecode:${agent}`, model, prompt="Verify...")
```
