---
name: claude-md-templates
description: Ready-to-use CLAUDE.md templates for frontend, backend, mobile, fullstack, monorepo, and specialized project types
level: 2
aliases: [templates, claudemd-template, project-template]
argument-hint: [list|frontend|backend|fullstack|mobile|monorepo|api|cli|library] - default is list
---

# CLAUDE.md Templates Skill

Generate tailored CLAUDE.md files for your project type. Each template encodes best practices, conventions, and AI behavior guidelines specific to the tech stack.

## Usage

```
/oh-my-claudecode:claude-md-templates
/oh-my-claudecode:claude-md-templates frontend
/oh-my-claudecode:claude-md-templates backend
/oh-my-claudecode:claude-md-templates fullstack
/oh-my-claudecode:claude-md-templates mobile
/oh-my-claudecode:claude-md-templates monorepo
```

Or say: "generate CLAUDE.md", "template for React project", "CLAUDE.md for backend"

## Available Templates

| Template | Stack | Best For |
|----------|-------|----------|
| `frontend` | React/Next.js/Vue/Svelte | SPA, SSR, static sites |
| `backend` | Node/Express/Fastify/Django/FastAPI/Go/Rust | APIs, services |
| `fullstack` | Next.js/Nuxt/SvelteKit/Rails | Full-stack apps |
| `mobile` | React Native/Flutter/Swift/Kotlin | Mobile apps |
| `monorepo` | Turborepo/Nx/Lerna | Multi-package repos |
| `api` | REST/GraphQL/gRPC | API-first services |
| `cli` | Node/Go/Rust/Python CLIs | Command-line tools |
| `library` | npm/PyPI/crates.io packages | Published libraries |

## Workflow

### Mode: List (default)

Display all available templates with descriptions. Ask which one to generate.

### Mode: Generate Template

#### 1. Detect Existing Stack

Before generating, scan the project to customize the template:

```
Task(subagent_type="oh-my-claudecode:explore", model="haiku", prompt="DETECT PROJECT STACK:
1. Package manager (npm/yarn/pnpm/pip/cargo/go)
2. Framework (next/nuxt/express/django/gin/actix)
3. Language version
4. Test framework
5. Lint/format tools
6. Build system
7. Database (if any)
8. Deployment target (if detectable)
Return structured JSON with detected values.")
```

#### 2. Generate Customized CLAUDE.md

##### Frontend Template

```markdown
# {Project Name}

## Project Overview
{auto-detected or user-provided description}

## Tech Stack
- Framework: {React/Next.js/Vue/Svelte} {version}
- Language: TypeScript {version}
- Styling: {Tailwind/CSS Modules/styled-components}
- State: {Zustand/Redux/Context/Signals}
- Testing: {Vitest/Jest/Playwright}

## Architecture
- `/src/components/` — Reusable UI components
- `/src/pages/` or `/src/app/` — Route pages
- `/src/hooks/` — Custom React hooks
- `/src/lib/` — Utilities and helpers
- `/src/types/` — TypeScript type definitions

## Conventions
- Components: PascalCase files, default export
- Hooks: camelCase, `use` prefix
- Types: PascalCase, exported from types/
- CSS: {Tailwind utility classes / CSS Modules with camelCase}
- Barrel exports: Only in `components/index.ts`, not in leaf modules

## Commands
- `{pm} run dev` — Start dev server
- `{pm} run build` — Production build
- `{pm} run test` — Run tests
- `{pm} run lint` — Lint code
- `{pm} run format` — Format code

## Testing Requirements
- Unit tests for all utility functions
- Component tests for interactive components
- E2E tests for critical user flows
- Minimum coverage: 80%

## AI Guidelines
- Use existing component patterns before creating new ones
- Follow the project's styling approach (don't mix Tailwind with CSS-in-JS)
- Prefer server components by default (Next.js App Router)
- Keep components small (<150 lines)
- Use semantic HTML elements
- Include aria labels for interactive elements
```

##### Backend Template

```markdown
# {Project Name}

## Project Overview
{description}

## Tech Stack
- Runtime: {Node.js/Python/Go/Rust} {version}
- Framework: {Express/Fastify/Django/FastAPI/Gin/Actix}
- Database: {PostgreSQL/MySQL/MongoDB/SQLite}
- ORM: {Prisma/Drizzle/SQLAlchemy/GORM}
- Testing: {Vitest/pytest/go test/cargo test}

## Architecture
- `/src/routes/` or `/src/controllers/` — API endpoints
- `/src/services/` — Business logic
- `/src/models/` or `/src/entities/` — Data models
- `/src/middleware/` — Request middleware
- `/src/lib/` — Shared utilities
- `/src/config/` — Configuration

## API Conventions
- RESTful resource naming (plural nouns)
- Standard HTTP status codes (200, 201, 400, 401, 403, 404, 500)
- Error response format: `{ "error": { "code": "...", "message": "..." } }`
- Pagination: `?page=1&limit=20` with `Link` headers
- Versioning: URL prefix `/api/v1/`

## Database Rules
- Always use migrations (never manual schema changes)
- Use parameterized queries (never string concatenation)
- Add indexes for columns used in WHERE/JOIN/ORDER BY
- Foreign keys for all relationships
- Soft delete with `deleted_at` column (not hard delete)

## Security
- Validate all input at the boundary
- Sanitize output to prevent XSS
- Use bcrypt/argon2 for password hashing
- JWT tokens with short expiry + refresh tokens
- Rate limiting on all public endpoints
- CORS configured explicitly (never `*` in production)

## Commands
- `{pm} run dev` — Start with hot reload
- `{pm} run build` — Production build
- `{pm} run test` — Run tests
- `{pm} run migrate` — Run database migrations
- `{pm} run seed` — Seed database

## AI Guidelines
- Never hardcode credentials or secrets
- Always add input validation for new endpoints
- Include error handling for all async operations
- Write integration tests for new API endpoints
- Follow existing service patterns for new features
- Add database indexes when adding new queries
```

##### Fullstack Template

Combines frontend + backend sections, plus:

```markdown
## Full-Stack Conventions
- Shared types between frontend and backend in `/shared/types/`
- API client generated from backend schema (if applicable)
- Environment variables: `.env.local` (frontend), `.env` (backend)
- Run both: `{pm} run dev` starts both frontend and backend
```

##### Mobile Template

```markdown
## Mobile Conventions
- Navigation: {React Navigation/Flutter Navigator/SwiftUI NavigationStack}
- State: {Redux/Riverpod/SwiftUI @Observable}
- Platform-specific code in `/{platform}/` directories
- Assets in `/assets/` with @1x, @2x, @3x variants
- Deep linking configured in app config
- Offline-first: cache API responses locally
- Handle all permission requests gracefully
- Test on both iOS and Android before PR
```

##### Monorepo Template

```markdown
## Monorepo Structure
- `/packages/` — Shared libraries
- `/apps/` — Deployable applications
- Workspace: {Turborepo/Nx/Lerna} with {npm/yarn/pnpm} workspaces
- Shared config: Root `tsconfig.json`, `.eslintrc`, `.prettierrc`
- Internal packages: `@{org}/{package}` naming
- Build order: Dependencies first, apps last
- Test each package independently: `{pm} run test --filter={package}`

## AI Guidelines for Monorepos
- Always specify which package/app you're working on
- Cross-package imports use workspace protocol
- Changes to shared packages require testing all consumers
- Version bumps coordinated across packages
```

##### API Template

```markdown
## API Design
- Schema-first: OpenAPI/GraphQL schema is source of truth
- Schema location: `/api/schema.{yaml|graphql}`
- Generate types from schema: `{pm} run generate`
- All endpoints documented in schema before implementation
- Breaking changes require version bump

## AI Guidelines for APIs
- Update schema before implementing endpoints
- Include request/response examples in schema
- Test edge cases: empty lists, max pagination, invalid IDs
- Rate limit headers on all responses
```

##### CLI Template

```markdown
## CLI Conventions
- Entry point: `/src/cli.{ts|go|rs}`
- Commands in `/src/commands/` (one file per command)
- Help text for every command and flag
- Exit codes: 0 (success), 1 (error), 2 (usage error)
- Support `--json` output for scriptability
- Respect `NO_COLOR` environment variable
- Stderr for progress/logs, stdout for results

## AI Guidelines for CLIs
- Keep startup time fast (<100ms)
- Graceful handling of Ctrl+C
- Clear error messages with suggested fixes
- Support both interactive and piped input
```

##### Library Template

```markdown
## Library Conventions
- Public API surface in `/src/index.{ts|py|rs}`
- Minimize exported types (public API should be small)
- Every public function has JSDoc/docstring/rustdoc
- Backwards compatibility: follow semver strictly
- Bundle size matters: tree-shakeable, no side effects

## AI Guidelines for Libraries
- Never add dependencies without justification
- Consider bundle size impact of every change
- Update README examples when API changes
- Write tests for documented behavior
- Changelog entry for every user-visible change
```

#### 3. Customize and Write

Present the generated template, allow customization, then write to `CLAUDE.md`.

If a CLAUDE.md already exists, show a diff and confirm before overwriting.

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Template generated** | Show template, confirm, write to CLAUDE.md |
| **List displayed** | Show available templates |
| **Existing CLAUDE.md** | Show diff, confirm before overwriting |
| **Unknown project type** | Ask user to specify or auto-detect |

## Notes

- **Templates are starting points**: Always customize for your specific project.
- **Merge, don't replace**: If a CLAUDE.md exists, merge new sections rather than overwriting.
- **Team-wide**: Share the CLAUDE.md via version control so the whole team benefits.
- **Keep it concise**: CLAUDE.md is loaded every session — aim for <2000 tokens.
- **Complements /deepinit**: Use templates for initial CLAUDE.md. Use `/deepinit` for detailed AGENTS.md hierarchy.

---

Begin template generation now. Parse the template type and detect the project stack.
