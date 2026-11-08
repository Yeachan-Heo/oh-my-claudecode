# Demo 4: Planning Interview

**Duration:** 2 minutes
**Objective:** Demonstrate interactive planning with AskUserQuestion UI for requirement gathering

## Pre-requisites

- Any project directory (can be empty or existing)
- OMC installed and configured
- Understanding that planning is for unclear/broad requirements

## Setup (30 seconds before demo)

```bash
cd ~/demo-workspace
mkdir -p auth-system-demo
cd auth-system-demo

# Can start with empty directory or minimal structure
# Planning will ask what you want
```

## The Command

```
plan the user authentication system
```

Or demonstrate with a broader request:
```
plan adding authentication to my app
```

## Expected Flow (1.5-2 minutes)

### Phase 1: Activation & Broad Request Detection (0:00-0:10)
**What happens:**
- OMC detects broad request: "authentication system" without specifics
- Plan skill activates
- Announces: "I'm starting a planning session - I'll interview you about requirements"

**Presenter talking points:**
- "OMC detected a broad request - 'authentication' could mean many things"
- "Instead of guessing, it starts an interview to understand what YOU want"
- "This is intelligent requirement gathering"

### Phase 2: Interactive Interview (0:10-1:00)
**What happens:**
- AskUserQuestion UI appears with clickable options
- Series of 3-5 questions about preferences:

**Question 1: Authentication Method**
```
What authentication method do you prefer?
[ ] JWT tokens (stateless)
[ ] Session-based (server-side)
[ ] OAuth 2.0 (third-party)
[ ] Multi-factor authentication
```

**Question 2: User Storage**
```
Where should user data be stored?
[ ] PostgreSQL (relational)
[ ] MongoDB (document)
[ ] In-memory (development)
[ ] External service (Auth0, etc.)
```

**Question 3: Security Requirements**
```
What security features are required?
[ ] Password hashing (bcrypt)
[ ] Rate limiting
[ ] Email verification
[ ] Password reset flow
[ ] All of the above
```

**Question 4: Scope**
```
What scope should we implement first?
[ ] Minimal viable (signup + login)
[ ] Standard (+ password reset)
[ ] Full-featured (+ MFA, email verification)
```

**Presenter talking points:**
- Point to UI: "See? Clickable options, not typing out responses"
- "Each answer narrows down the requirements"
- "Plan is learning your preferences, constraints, priorities"
- Click through options: "Let's say JWT tokens, PostgreSQL, standard security, MVP scope"

### Phase 3: Analysis & Design (1:00-1:30)
**What happens:**
- Analyst agent synthesizes user responses into formal requirements
- Architect agent designs system based on requirements
- Critic agent reviews the design

**Presenter talking points:**
- "Now three agents collaborate to build the plan"
- "Analyst: Converts your answers into formal requirements doc"
- "Architect: Designs the system architecture"
- "Critic: Reviews for gaps, risks, edge cases"

### Phase 4: Plan Presentation (1:30-2:00)
**What happens:**
- Comprehensive plan presented:
  - Requirements summary
  - Architecture overview
  - File structure
  - Implementation phases
  - Test strategy
  - Acceptance criteria

**Presenter talking points:**
- "Here's the final plan - structured, actionable, validated"
- Point to sections: "Requirements we gathered, architecture designed, phases to implement"
- "This plan is saved to `.omc/plans/auth-system.md`"
- "You can review, modify, or execute immediately"

## Expected Output

### Terminal Output
```
$ plan the user authentication system

I'm starting a planning session - I'll interview you about requirements.

[QUESTION 1/4]
What authentication method do you prefer?

Options:
  1. JWT tokens (stateless)
  2. Session-based (server-side)
  3. OAuth 2.0 (third-party)
  4. Multi-factor authentication

Your choice: 1

[QUESTION 2/4]
Where should user data be stored?

Options:
  1. PostgreSQL (relational)
  2. MongoDB (document)
  3. In-memory (development only)
  4. External service (Auth0, Firebase)

Your choice: 1

[QUESTION 3/4]
What security features are required?

Options:
  1. Basic (password hashing only)
  2. Standard (+ rate limiting, email verification)
  3. Advanced (+ MFA, security questions)
  4. Enterprise (+ SSO, audit logs)

Your choice: 2

[QUESTION 4/4]
What scope should we implement first?

Options:
  1. Minimal (signup + login only)
  2. Standard (+ password reset)
  3. Full-featured (+ email verification, MFA)

Your choice: 2

Thank you! Analyzing your requirements...

[ANALYSIS PHASE]
Spawning analyst to synthesize requirements...
✓ Analyst completed requirements specification (15s)

[DESIGN PHASE]
Spawning architect to design system...
✓ Architect completed system design (22s)

[VALIDATION PHASE]
Spawning critic to review design...
✓ Critic approved design with suggestions (12s)

[PLAN READY]

═══════════════════════════════════════════════════════════
                    AUTHENTICATION SYSTEM PLAN
═══════════════════════════════════════════════════════════

REQUIREMENTS SUMMARY
────────────────────
• Authentication: JWT tokens (stateless)
• Storage: PostgreSQL
• Security: Password hashing (bcrypt), rate limiting, email verification
• Scope: Signup, login, password reset

ARCHITECTURE OVERVIEW
─────────────────────
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   Client    │─────→│  Auth API    │─────→│  PostgreSQL │
└─────────────┘      └──────────────┘      └─────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ Email Service│
                     └──────────────┘

COMPONENTS
──────────
1. User Model (id, email, password_hash, verified, created_at)
2. Auth Controller (signup, login, reset-password routes)
3. JWT Service (token generation, validation)
4. Email Service (verification emails, password reset)
5. Rate Limiter (protect against brute force)
6. Password Hasher (bcrypt wrapper)

FILE STRUCTURE
──────────────
src/
├── models/
│   └── User.ts
├── controllers/
│   └── AuthController.ts
├── services/
│   ├── JWTService.ts
│   ├── EmailService.ts
│   └── PasswordService.ts
├── middleware/
│   ├── authenticate.ts
│   └── rateLimiter.ts
├── routes/
│   └── auth.ts
└── app.ts

IMPLEMENTATION PHASES
─────────────────────
Phase 1: Core Setup (1-2 hours)
  • Database schema and migrations
  • User model
  • Password hashing service

Phase 2: Authentication (2-3 hours)
  • Signup endpoint
  • Login endpoint
  • JWT generation and validation
  • Authentication middleware

Phase 3: Email & Verification (2 hours)
  • Email service setup
  • Email verification flow
  • Password reset flow

Phase 4: Security Hardening (1 hour)
  • Rate limiting
  • Input validation
  • Security headers

Phase 5: Testing (2 hours)
  • Unit tests for services
  • Integration tests for auth flow
  • Security tests

TEST STRATEGY
─────────────
• Unit tests: Services (JWT, Password, Email)
• Integration tests: Auth flow (signup → verify → login → reset)
• Security tests: Rate limiting, SQL injection, XSS
• Load tests: Token validation performance

ACCEPTANCE CRITERIA
───────────────────
✓ User can sign up with email + password
✓ Email verification sent and processed
✓ User can log in and receive JWT token
✓ JWT token validates correctly
✓ User can request password reset
✓ Password reset email sent with secure token
✓ Rate limiting prevents brute force
✓ All tests passing (100% critical path coverage)
✓ No security vulnerabilities (OWASP Top 10)

RISKS & MITIGATIONS
───────────────────
Risk: Email delivery failures
  → Mitigation: Queue system with retries, fallback to SMS

Risk: JWT token theft
  → Mitigation: Short expiry (15m), refresh tokens, HTTPS only

Risk: Database breach
  → Mitigation: Bcrypt with high work factor, encrypted at rest

DEPENDENCIES
────────────
• express (web framework)
• pg (PostgreSQL client)
• bcrypt (password hashing)
• jsonwebtoken (JWT handling)
• nodemailer (email sending)
• express-rate-limit (rate limiting)
• joi (input validation)

NEXT STEPS
──────────
1. Review this plan
2. Modify if needed: edit .omc/plans/auth-system.md
3. Execute: "implement the auth plan" or "ralph: implement auth-system.md"

Plan saved to: .omc/plans/auth-system.md
═══════════════════════════════════════════════════════════

Ready to proceed? Say "implement the plan" to execute.
```

## Key Talking Points

### What makes planning special?
1. **Interactive interview** - Asks YOU what you want, doesn't assume
2. **AskUserQuestion UI** - Clickable options, not typing long responses
3. **Multi-agent consensus** - Analyst, Architect, Critic collaborate on plan
4. **Structured output** - Not a wall of text, but organized plan document
5. **Executable plan** - Saved to file, can be executed later with "implement the plan"

### When to use planning
- Requirements are unclear or broad
- Starting a new feature/module
- Want to explore options before committing
- Need alignment with team (share the plan doc)
- Complex project with multiple approaches

### The interview process
- **Preference questions** - "What do you prefer?" (JWT vs sessions)
- **Requirement questions** - "What features are needed?" (MFA, email verification)
- **Scope questions** - "MVP or full-featured?" (prioritization)
- **Constraint questions** - "Any limitations?" (time, budget, tech stack)

### Architecture highlight
- "Plan skill is opinionated - it asks smart questions based on context"
- "For authentication, it knows to ask about storage, security, verification"
- "For a REST API, it would ask about database, caching, rate limiting"
- "The questions adapt to your domain"

## Fallback: Pre-recorded Output

Show the complete terminal output from "Expected Output" section above.

Additionally, demonstrate the saved plan file:

```bash
$ cat .omc/plans/auth-system.md

# Authentication System Plan

Generated: 2026-01-27T10:23:45Z
Status: ready_for_implementation

## User Preferences
- Authentication method: JWT tokens (stateless)
- Storage: PostgreSQL
- Security level: Standard (hashing + rate limiting + email verification)
- Scope: MVP + password reset

## Requirements
[... full plan content ...]
```

## Common Issues & Troubleshooting

### Issue: User doesn't understand a question
**Solution:**
- Plan provides context with each question
- User can ask for clarification: "What's the difference between JWT and sessions?"
- Plan will explain before re-asking

### Issue: User wants option not listed
**Solution:**
- Most questions have "Other (specify)" option
- User can type custom requirement
- Plan adapts to custom inputs

### Issue: Interview takes too long
**Solution:**
- Plan keeps it to 3-5 key questions
- User can skip questions (plan will use reasonable defaults)
- Or use autopilot to skip planning entirely

## Demo Variations

### Variation 1: Ralplan (Iterative Planning)
```
ralplan the authentication system
```

"Ralplan adds iteration - after first plan, Planner, Architect, and Critic debate until consensus. Better for complex projects."

### Variation 2: Review Existing Plan
```
/oh-my-claudecode:review auth-system
```

"Review skill spawns Critic to analyze an existing plan and suggest improvements."

### Variation 3: Execute the Plan
After planning:
```
implement the auth-system plan
```

"Execute the plan - autopilot mode with the plan as specification."

## Presenter Tips

### During Interview
- **Click deliberately** - Give audience time to see each question
- **Read options aloud** - "Option 1: JWT tokens for stateless auth..."
- **Explain your choice** - "I'm choosing JWT because it scales better"
- **Show the thinking** - "Notice how question 3 built on our JWT choice?"

### During Analysis
- **Point out agents** - "Analyst is now synthesizing our answers into formal requirements"
- **Highlight collaboration** - "Architect designs based on analyst's requirements"
- **Explain consensus** - "Critic validates - three agents, one plan"

### During Plan Presentation
- **Scroll slowly** - Let audience read sections
- **Highlight structure** - "See: Requirements, Architecture, Phases, Tests, Acceptance Criteria"
- **Emphasize completeness** - "This isn't just code - it's a full implementation roadmap"

## Transition to Next Demo

"That's planning - interactive requirement gathering with intelligent questions. But planning is just the start. What if the work is complex and might hit errors? What if you need guaranteed completion? That's where Ralph comes in - our final demo."

**Transition action:** Navigate to a directory with a complex refactoring task for Ralph demo

## Q&A Preparation

**Q: Can I skip the interview and just tell it what I want?**
A: Yes! Provide details upfront: "plan JWT-based auth with PostgreSQL and email verification". Plan will ask fewer questions or skip interview entirely.

**Q: Can I modify the plan after it's generated?**
A: Absolutely! Plans are saved as markdown in `.omc/plans/`. Edit the file, then execute it.

**Q: How does plan know what questions to ask?**
A: The plan skill has domain knowledge. For auth, it knows to ask about tokens vs sessions. For REST APIs, it knows to ask about databases, caching, etc. It adapts to context.

**Q: What if I don't know the answer to a question?**
A: Plan provides a "Recommend based on best practices" option. It will choose sensible defaults.

**Q: Can I reuse plans across projects?**
A: Yes! Plans are templates. Save to a shared location, adapt to new projects. Common patterns become reusable blueprints.

**Q: Difference between plan and ralplan?**
A:
- `plan`: Single-pass (Analyst → Architect → Critic → done)
- `ralplan`: Iterative (multiple rounds of Planner ↔ Architect ↔ Critic until consensus)
- Use ralplan for complex, high-stakes projects where you want deep validation

**Q: Can I share plans with my team?**
A: Yes! Plans are markdown files. Commit to git, share in docs, use as RFCs. They're human-readable and version-controllable.
