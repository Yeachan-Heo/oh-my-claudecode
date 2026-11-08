# Demo 5: Ralph - Persistence Until Complete

**Duration:** 2 minutes
**Objective:** Demonstrate persistent execution with self-correction and architect verification

## Pre-requisites

- Project with a complex refactoring task that might hit errors
- OMC installed and configured
- Understanding that Ralph never gives up until verified complete

## Setup (2 minutes before demo)

Option A: Create a legacy code needing refactoring
```bash
cd ~/demo-workspace
mkdir -p legacy-auth-refactor
cd legacy-auth-refactor

# Create old-style authentication code
cat > auth.js << 'EOF'
// Legacy authentication - needs refactoring to TypeScript + JWT

var users = {};  // In-memory user storage
var sessions = {};  // Session storage

function signup(username, password) {
  if (users[username]) {
    return {success: false, error: "User exists"};
  }
  // Plain text password storage (BAD!)
  users[username] = {
    password: password,
    createdAt: new Date()
  };
  return {success: true};
}

function login(username, password) {
  var user = users[username];
  if (!user) {
    return {success: false, error: "User not found"};
  }
  if (user.password != password) {  // Plain comparison
    return {success: false, error: "Wrong password"};
  }
  // Create session
  var sessionId = Math.random().toString(36);
  sessions[sessionId] = {
    username: username,
    createdAt: new Date()
  };
  return {success: true, sessionId: sessionId};
}

function verify(sessionId) {
  var session = sessions[sessionId];
  if (!session) {
    return {valid: false};
  }
  // No expiry check!
  return {valid: true, username: session.username};
}

module.exports = {signup, login, verify};
EOF

# Create package.json
cat > package.json << 'EOF'
{
  "name": "legacy-auth-refactor",
  "version": "1.0.0",
  "main": "auth.js"
}
EOF
```

Option B: Use a real module in your codebase that needs refactoring

## The Command

```
ralph: refactor auth.js to use TypeScript, JWT tokens, bcrypt password hashing, and proper error handling
```

Or shorter version:
```
ralph: migrate auth to modern TypeScript + JWT
```

## Expected Flow (1.5-2 minutes)

### Phase 1: Activation & Initial Analysis (0:00-0:15)
**What happens:**
- Ralph mode activates
- Announces: "I'm activating ralph-loop to ensure this task completes fully"
- Architect agent analyzes the legacy code
- Identifies: Multiple issues (plain text passwords, no types, sessions instead of JWT, etc.)

**Presenter talking points:**
- "Ralph activates - this means 'don't stop until verified complete'"
- "Starting with deep analysis of what needs to change"
- "Notice: Multiple problems detected - this is a complex refactoring"

### Phase 2: First Attempt (0:15-0:45)
**What happens:**
- Executor agent starts refactoring
- Converts to TypeScript
- Adds JWT implementation
- Hits an error: Missing bcrypt types

**Presenter talking points:**
- "First attempt: Converting to TypeScript, adding JWT"
- Point to error: "Hit an error - missing type definitions"
- "In normal mode, this might stop. Ralph? Self-corrects."

### Phase 3: Self-Correction Loop (0:45-1:15)
**What happens:**
- Ralph detects the error
- Spawns build-fixer to install @types/bcrypt
- Re-runs the refactoring
- Hits another issue: JWT secret not configured
- Ralph fixes it: Adds environment variable handling
- Re-runs again

**Presenter talking points:**
- "Watch Ralph self-correct: Error detected → Fix applied → Retry"
- "This is the persistence loop - each error gets fixed automatically"
- "No manual intervention needed - Ralph handles obstacles"
- Count iterations: "Iteration 1: Type error. Iteration 2: Config error. Iteration 3..."

### Phase 4: Verification (1:15-1:45)
**What happens:**
- Refactoring appears complete
- Ralph spawns Architect for verification
- Architect checks:
  - TypeScript compilation: ✓
  - JWT implementation: ✓
  - Bcrypt hashing: ✓
  - Error handling: ✓
  - No plain text passwords: ✓

**Presenter talking points:**
- "Now the crucial part - Architect verification"
- "Ralph won't claim 'done' without Architect approval"
- "Architect checks: Compilation, security, correctness, completeness"
- "This is the 'verification-before-completion' protocol in action"

### Phase 5: Completion (1:45-2:00)
**What happens:**
- Architect approves
- Ralph outputs completion summary:
  - Iterations: 3
  - Errors encountered and fixed: 2
  - Files refactored: 1
  - Tests added: 1
  - Security improvements: Password hashing, JWT tokens
  - Verification: Passed

**Presenter talking points:**
- "Architect approved - NOW Ralph says 'complete'"
- "Summary shows the journey: 3 iterations, 2 errors fixed automatically"
- "From legacy JavaScript to modern TypeScript + security best practices"
- "All without stopping for manual intervention"

## Expected Output

### Terminal Output
```
$ ralph: refactor auth.js to use TypeScript, JWT tokens, bcrypt password hashing, and proper error handling

I'm activating ralph-loop to ensure this task completes fully.

[RALPH ITERATION 1]
Analyzing legacy code...
✓ Analysis complete (8s)

Issues Identified:
  🔴 CRITICAL: Plain text password storage
  🔴 CRITICAL: No password hashing
  🟡 HIGH: JavaScript instead of TypeScript
  🟡 HIGH: Session-based auth (should be JWT)
  🟡 MEDIUM: No error handling
  🟡 MEDIUM: No input validation
  🟡 MEDIUM: Sessions never expire

Starting refactoring...
[executor] Converting to TypeScript...
[executor] Implementing JWT authentication...
[executor] Adding bcrypt password hashing...

✗ Error encountered (22s):
  Cannot find module '@types/bcrypt'

Ralph: Self-correcting...

[RALPH ITERATION 2]
[build-fixer] Installing @types/bcrypt and bcrypt...
✓ Dependencies installed (8s)

Retrying refactoring...
[executor] Continuing TypeScript conversion...
[executor] Configuring JWT service...

✗ Error encountered (18s):
  JWT_SECRET environment variable not defined

Ralph: Self-correcting...

[RALPH ITERATION 3]
[executor] Adding environment variable handling...
[executor] Creating .env.example with JWT_SECRET...
[executor] Updating error messages...
✓ Refactoring complete (25s)

Ralph: Requesting architect verification...

[ARCHITECT VERIFICATION]
Spawning architect for final verification...

Architect checking:
  ✓ TypeScript compilation: No errors
  ✓ JWT implementation: Correct (generation + validation)
  ✓ Bcrypt hashing: Proper work factor (10 rounds)
  ✓ Error handling: All paths covered
  ✓ Input validation: Email + password validation added
  ✓ Security: No plain text passwords, secure token storage
  ✓ Tests: Unit tests added for auth functions
  ✓ Documentation: JSDoc comments added

Architect verdict: ✓ APPROVED (12s)

[RALPH COMPLETE]

═══════════════════════════════════════════════════════════
                    REFACTORING COMPLETE
═══════════════════════════════════════════════════════════

Summary:
  Ralph iterations: 3
  Errors encountered: 2
  Errors auto-fixed: 2

  Files created/modified:
    ✓ auth.ts (migrated from auth.js)
    ✓ types.ts (new - type definitions)
    ✓ auth.test.ts (new - unit tests)
    ✓ .env.example (new - configuration template)
    ✓ package.json (updated - new dependencies)

  Security improvements:
    ✓ Bcrypt password hashing (work factor: 10)
    ✓ JWT tokens with expiry (15m access, 7d refresh)
    ✓ No plain text password storage
    ✓ Rate limiting hooks added

  Code quality:
    ✓ TypeScript with strict mode
    ✓ Comprehensive error handling
    ✓ Input validation (email format, password strength)
    ✓ JSDoc documentation
    ✓ Unit tests (100% coverage)

  Verification:
    ✓ TypeScript compilation: 0 errors
    ✓ Tests: 8/8 passing
    ✓ Architect approval: GRANTED

Total time: 2m 15s
Next steps: Review auth.ts, set JWT_SECRET in .env, run tests

Ralph: Task verified complete. 🎯
═══════════════════════════════════════════════════════════
```

### Refactored Code Preview

**auth.ts** (new):
```typescript
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

interface User {
  passwordHash: string;
  email: string;
  createdAt: Date;
}

interface AuthResult {
  success: boolean;
  token?: string;
  error?: string;
}

const users: Map<string, User> = new Map();
const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set');
}

/**
 * Sign up a new user with email and password
 */
export async function signup(email: string, password: string): Promise<AuthResult> {
  // Validation
  if (!email || !email.includes('@')) {
    return { success: false, error: 'Invalid email format' };
  }
  if (!password || password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' };
  }

  // Check existing user
  if (users.has(email)) {
    return { success: false, error: 'User already exists' };
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Store user
  users.set(email, {
    passwordHash,
    email,
    createdAt: new Date()
  });

  return { success: true };
}

/**
 * Login user and return JWT token
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const user = users.get(email);

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Invalid password' };
  }

  // Generate JWT token
  const token = jwt.sign(
    { email, createdAt: user.createdAt },
    JWT_SECRET!,
    { expiresIn: '15m' }
  );

  return { success: true, token };
}

/**
 * Verify JWT token and return user email
 */
export function verify(token: string): { valid: boolean; email?: string } {
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as { email: string };
    return { valid: true, email: decoded.email };
  } catch (error) {
    return { valid: false };
  }
}
```

## Key Talking Points

### What makes Ralph special?
1. **Never gives up** - Errors trigger self-correction, not failure
2. **Self-correction loop** - Error → Diagnose → Fix → Retry (automatically)
3. **Architect verification** - Won't claim complete without approval
4. **Iteration tracking** - Shows the journey, not just the destination
5. **Complex task handling** - Perfect for refactoring, migrations, multi-step work

### When to use Ralph
- Complex refactoring that might hit edge cases
- Migrations (tech stack, database, architecture)
- Mission-critical features that must work
- When you need guaranteed completion
- Tasks with unknown obstacles

### The Ralph Loop
```
1. Attempt task
2. Hit error? → Diagnose
3. Apply fix
4. Retry from step 1
5. Success? → Request architect verification
6. Architect approves? → Complete
7. Architect rejects? → Back to step 1
```

### Architecture highlight
- "Ralph combines autopilot's multi-agent workflow with error resilience"
- "Each iteration learns from previous errors"
- "Architect verification is mandatory - no false completions"
- "State is persisted - Ralph can resume if interrupted"

## Fallback: Pre-recorded Output

Show the complete terminal output from "Expected Output" section above.

Additionally, show the iteration timeline:

```
RALPH TIMELINE

0:00 ─┬─ Iteration 1: Initial refactoring attempt
      │   ├─ Analyze legacy code (8s)
      │   ├─ Start TypeScript conversion (15s)
      │   └─ ✗ ERROR: Missing @types/bcrypt
      │
0:23 ─┼─ Iteration 2: Self-correction #1
      │   ├─ Install missing types (8s)
      │   ├─ Retry TypeScript conversion (12s)
      │   └─ ✗ ERROR: JWT_SECRET not configured
      │
0:43 ─┼─ Iteration 3: Self-correction #2
      │   ├─ Add environment handling (6s)
      │   ├─ Complete refactoring (19s)
      │   └─ ✓ SUCCESS: All code working
      │
1:08 ─┼─ Architect Verification
      │   ├─ TypeScript check (2s)
      │   ├─ Security review (4s)
      │   ├─ Test coverage check (3s)
      │   └─ ✓ APPROVED
      │
1:20 ─┴─ COMPLETE: Task verified and approved

Total: 3 iterations, 2 self-corrections, 1m 20s
```

## Common Issues & Troubleshooting

### Issue: Too many iterations
**Solution:**
- Good for the demo! Point out: "Ralph is thorough - keeps iterating until perfect"
- Explain: "Each iteration fixes something - it's making progress"
- Typical: 2-5 iterations for complex refactoring

### Issue: Architect rejects the work
**Solution:**
- Excellent teaching moment! "See? Architect caught an issue we missed"
- Show Ralph going back to fix it: "This is quality control in action"
- Emphasize: "Better to catch issues now than in production"

### Issue: Task completes on first try (no errors)
**Solution:**
- Still demonstrates the verification: "No errors, but architect still verifies"
- Point out: "Single iteration - Ralph is efficient when possible"
- Explain: "The self-correction is there when you NEED it"

## Demo Variations

### Variation 1: Ralph with Structured PRD
```
/oh-my-claudecode:ralph-init
```

"Ralph-init creates a Product Requirements Document. Ralph then works against that PRD with structured verification."

### Variation 2: Show Ralph State
```bash
cat .omc/state/ralph-state.json
```

"Ralph state shows iteration history, errors encountered, fixes applied. Useful for debugging complex migrations."

### Variation 3: Combine Ralph + Ultrawork
```
ralph ulw: refactor all auth modules to TypeScript
```

"Ralph for persistence, ultrawork for parallelism. Maximum reliability AND speed."

## Presenter Tips

### During Iterations
- **Count aloud** - "That's iteration 1... now iteration 2..."
- **Point to errors** - "See the error? Missing dependency. Watch Ralph fix it..."
- **Highlight self-correction** - "No manual intervention - Ralph diagnosed and fixed it automatically"

### During Verification
- **Build suspense** - "Now the moment of truth - will Architect approve?"
- **Explain each check** - "TypeScript compilation... Security review... Tests..."
- **Emphasize rigor** - "This is what 'done' means - not 'works on my machine', but verified complete"

### During Completion
- **Show the summary** - "3 iterations, 2 self-corrections, all automatic"
- **Compare to manual** - "Manually, you'd fix error 1, run, fix error 2, run, verify... hours of work"
- **Highlight value** - "Ralph did it all in 2 minutes while you grabbed coffee"

## Closing Statement

"That's Ralph - your persistent agent that never gives up. Errors? Fixed automatically. Complete? Only when architect-verified. This is what makes OMC production-ready, not just a demo."

**Transition to Q&A or Summary:**

"We've seen five modes of OMC:
1. **Autopilot** - Full autonomous execution
2. **Ultrawork** - Maximum parallelism
3. **Pipeline** - Sequential coordination
4. **Planning** - Interactive requirement gathering
5. **Ralph** - Persistent completion

Together, they transform Claude from a helpful assistant into a development team. Questions?"

## Q&A Preparation

**Q: How does Ralph know when to stop iterating?**
A: Two conditions: (1) No errors in execution, AND (2) Architect verification passes. Both must be true.

**Q: What if Ralph gets stuck in an infinite loop?**
A: Ralph has max iteration limits (default 10) and timeout protection. If truly stuck, it reports the blocker and asks for help.

**Q: Difference between Ralph and autopilot?**
A:
- **Autopilot**: Full workflow from idea to code (includes planning, execution, QA)
- **Ralph**: Adds persistence layer to any workflow (can combine: "ralph autopilot")
- Think: Autopilot = what to do, Ralph = keep doing it until verified

**Q: Can Ralph handle database migrations?**
A: Yes! Perfect use case. Ralph will attempt migration, handle errors (missing columns, type mismatches, etc.), verify data integrity, and only complete when architect confirms successful migration.

**Q: Token cost of Ralph?**
A: Higher than single-pass due to iterations, but you're paying for guaranteed completion. A failed manual attempt costs MORE (wasted time + tokens).

**Q: Can I see what Ralph is thinking during iterations?**
A: Yes! Check `.omc/state/ralph-state.json` for iteration log, or use verbose mode: "ralph --verbose: refactor X"

**Q: What happens if I cancel Ralph mid-iteration?**
A: State is saved. Resume with "resume ralph" or "/oh-my-claudecode:resume-session". It picks up where it left off.

**Q: Best practices for Ralph tasks?**
A:
- Be specific about requirements (Ralph is persistent, not psychic)
- For very complex tasks, use ralplan first to create a solid plan
- Combine with ultrawork for speed: "ralph ulw: migrate all services"
- Trust the verification - if architect rejects, there's a reason
