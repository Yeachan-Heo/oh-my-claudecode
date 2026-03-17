<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-31 | Updated: 2026-02-24 -->

# docs

User documentation and technical guides for oh-my-claudecode.

## Purpose

This directory contains documentation for end-users and developers:

- **End-user guides**: How to use oh-my-claudecode features
- **Technical reference**: Architecture, compatibility, migration
- **Design documents**: Feature design specifications

## Key Files

| File | Description |
|------|-------------|
| `GETTING-STARTED.md` | Installation, first session, and configuration guide |
| `ARCHITECTURE.md` | System architecture overview (agents, skills, hooks, state) |
| `HOOKS.md` | Comprehensive hooks system documentation (31 hooks) |
| `TOOLS.md` | MCP tools reference (state, notepad, LSP, AST, Python REPL) |
| `REFERENCE.md` | Quick-reference for agents, skills, hooks, and configuration |
| `FEATURES.md` | Internal developer API reference |
| `CLAUDE.md` | End-user orchestration instructions (installed to user projects) |
| `MIGRATION.md` | Version migration guides |
| `COMPATIBILITY.md` | MCP/Plugin compatibility layer documentation |
| `DELEGATION-ENFORCER.md` | Delegation protocol documentation |
| `SYNC-SYSTEM.md` | Metadata synchronization system |
| `PERFORMANCE-MONITORING.md` | Performance monitoring and debugging guide |
| `LOCAL_PLUGIN_INSTALL.md` | Local plugin installation for developers |
| `OPENCLAW-ROUTING.md` | OpenClaw/Clawhip routing contract |
| `CJK-IME-KNOWN-ISSUES.md` | CJK input method known issues |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `design/` | Feature design specifications and architecture proposals |
| `agent-templates/` | Reusable agent prompt templates |
| `partials/` | Reusable documentation fragments |
| `ko/` | Korean translations of documentation |
| `issues/` | Bug reference materials |

## For AI Agents

### Working In This Directory

1. **End-User Focus**: CLAUDE.md is installed to user projects - write for end-users, not developers
2. **Keep Links Accessible**: Use raw GitHub URLs for links in CLAUDE.md (agents can't navigate GitHub UI)
3. **Version Consistency**: Update version numbers across all docs when releasing

### When to Update Each File

| Trigger | File to Update |
|---------|---------------|
| Agent count or list changes | `REFERENCE.md` (Agents section) |
| Skill count or list changes | `REFERENCE.md` (Skills section) |
| Hook count or list changes | `REFERENCE.md` (Hooks System section) |
| Magic keywords change | `REFERENCE.md` (Magic Keywords section) |
| Agent tool assignments change | `CLAUDE.md` (Agent Tool Matrix) |
| Skill composition or architecture changes | `ARCHITECTURE.md` |
| New internal API or feature | `FEATURES.md` |
| Breaking changes or migrations | `MIGRATION.md` |
| Tiered agent design updates | `design/TIERED_AGENTS_V2.md` |
| Platform or version support changes | `COMPATIBILITY.md` |
| End-user instructions change | `CLAUDE.md` |
| Major user-facing features | `../README.md` |

### Testing Requirements

- Verify markdown renders correctly
- Check all internal links resolve
- Validate code examples in documentation

### Common Patterns

#### Linking to Raw Content

Use raw GitHub URLs for external accessibility:

[Migration Guide](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/MIGRATION.md)

#### Version References

Use consistent version heading format with blank line after heading:

```markdown
## v3.8.17 Changes

- Feature A
- Feature B
```

## Dependencies

### Internal

- References agents from `agents/`
- References skills from `skills/`
- References tools from `src/tools/`

### External

None - pure markdown files.

<!-- MANUAL:
- When documenting `plan`/`ralplan`, include consensus structured deliberation (RALPLAN-DR) and note `--deliberate` high-risk mode behavior.
-->
