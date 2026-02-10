# oh-my-claudecode v4.1.2: Team Model Inheritance

## Changes

### Changed
- **Team skill**: Removed hardcoded `model: "sonnet"` default for team members. Teammates now inherit the user's session model instead of being forced to Sonnet. Since each teammate is a full Claude Code session capable of spawning its own subagents, the session model serves as the orchestration layer.
- **Team config**: Removed `defaultModel` from `.omc-config.json` team configuration options.

---

# oh-my-claudecode v4.1.1: Session Isolation & Flexible MCP Routing

This patch release hardens session isolation for parallel workflows, unblocks flexible MCP agent routing, and enhances the setup wizard with agent teams configuration.

---

### Added

- **Agent Teams Setup**: The `omc-setup` wizard now includes Step 5.5 to configure Claude Code's experimental Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), including `teammateMode` selection and team defaults. (#484)

### Changed

- **Flexible MCP Routing**: Removed per-provider enum restriction on `agent_role` for `ask_codex` and `ask_gemini` MCP tools. Both now accept any valid agent role (~30 types); provider-specific strengths are documented as recommendations, not enforced gates. (#485)

### Fixed

- **Session State Isolation**: Eliminated cross-session state contamination when multiple Claude Code sessions run in the same directory. When `session_id` is known, legacy shared state is invisible — no fallback to shared paths. Adds `isSessionMatch()` helper for consistent session matching across all 8 modes. (#486)
- **State Write Warnings**: Added warnings in MCP `state_write` when `session_id` is missing, preventing accidental shared-state writes. (#486)

---

# oh-my-claudecode v4.1.0: The Consolidation & Coordination Update

This major release introduces a fundamental overhaul of the agent architecture, streamlines skills and commands, and rolls out a powerful new Team Coordination system for distributed, resilient multi-agent workflows.

---

### 💥 Breaking Changes & Migration

The previous tiered agent system (`-low`, `-medium`, `-high` suffixes) has been deprecated and removed. This was done to simplify the user experience and align with modern model capabilities.

**Migration Guide:**
- **Action Required:** Users must update their scripts, configurations, and custom commands.
- **How to Update:** Instead of selecting agents by tier (e.g., `planner-high`), you now use a single, unified agent (e.g., `planner`) and specify the desired model size/capability via your Claude Code settings or model parameters.
- **Example:** A call to `Task(subagent_type="oh-my-claudecode:architect-high", ...)` should become `Task(subagent_type="oh-my-claudecode:architect", model="opus", ...)`.

---

### 🚀 Headline Feature: Agent Architecture Reform

The agent ecosystem has been completely reformed. We've consolidated the previous 34 tiered agents into **28 unified, specialized agents**. This new structure emphasizes role-based specialization over a confusing tier system, with model capability now handled by parameter routing. This change simplifies agent selection and improves the clarity of each agent's purpose. (#480, #481)

- **Unified Agent Roster**: Deprecated `-low`, `-medium`, and `-high` agent variants in favor of a single, unified roster.
- **New Specialist Agents**: Introduced a suite of new agents to cover more specialized tasks:
  - `debugger`: For root-cause analysis and bug fixing.
  - `verifier`: For validating logic and results.
  - `style-reviewer`: For enforcing coding style and conventions.
  - `quality-reviewer`: For assessing overall code quality.
  - `api-reviewer`: For analyzing API design and usage.
  - `performance-reviewer`: For identifying performance bottlenecks.
  - `dependency-expert`: For managing and analyzing project dependencies.
  - `test-engineer`: For creating and maintaining tests.
  - `quality-strategist`: For high-level quality assurance planning.
  - `product-manager`: For aligning work with product goals.
  - `ux-researcher`: For user experience analysis.
  - `information-architect`: For organizing and structuring information.
  - `product-analyst`: For analyzing product requirements and behavior.
- **System Integration**: Completed HUD codes, system prompts, and short names for all 28 agents to ensure full integration into the OMC ecosystem. (f5746a8)

---

### 🤝 Feature: Advanced Team Coordination

Introducing the **MCP Team Workers Bridge Daemon**, a major leap forward for multi-agent collaboration. This system enables robust, resilient, and observable distributed workflows.

- **Team Bridge Daemon**: A new background service (`mcp-team-workers`) orchestrates tasks among multiple agent "workers." (e16e2ad)
- **Enhanced Resilience**: Implemented hybrid orchestration, the use of `git worktrees` for isolated task execution, and improved observability to make team operations more robust. (0318f01)
- **Atomic Task Claiming**: Replaced the previous `sleep+jitter` mechanism with atomic, `O_EXCL` lock files. This prevents race conditions and ensures that a task is claimed by only one worker at a time. (c46c345, 7d34646)
- **Security Hardening**: Fortified the team bridge against a range of vulnerabilities, including file descriptor (FD) leaks, path traversal attacks, and improved shutdown procedures. (#462, #465)
- **Permission Enforcement**: Added a post-execution permission enforcement layer for MCP workers, ensuring that agents operate within their designated security boundaries. (fce3375, 6a7ec27)

---

### ✍️ Feature: System Prompt Rewrite for Claude Opus 4.6

In line with Anthropic's latest prompting best practices, the core system prompt (`docs/CLAUDE.md`) has been completely rewritten for significantly improved performance, reliability, and tool-use accuracy.

- **Best Practices**: The new prompt leverages XML behavioral tags (`<operating_principles>`, `<delegation_rules>`, `<agent_catalog>`, etc.), uses calm and direct language, and provides a comprehensive, structured reference for all available tools and skills. (42aad26)
- **Production Readiness**: Addressed feedback from a production readiness review to ensure the prompt is robust and effective. (d7317cb)

---

### 🔧 Skill & Command Consolidation

To reduce complexity and improve user experience, several skills and commands have been merged and formalized. (#471)

- **Merged Skills**:
  - `local-skills-setup` has been merged into the core `skill` command.
  - `learn-about-omc` is now part of the `help` command.
  - `ralplan` and `review` have been consolidated into the `plan` command. (dae0cf9, dd63c4a)
- **Command Aliases**: Added `ralplan` and `review` as aliases for `plan` to maintain backward compatibility for user muscle memory. (217a029)
- **Formalized Structure**: Clarified the distinction between "commands" (user-facing entry points) and "skills" (internal agent capabilities). `analyze`, `git-master`, and `frontend-ui-ux` are now thin routing layers to their respective underlying skills. (#470)
- **Cleanup**: Removed dead skills, orphan references, and updated documentation to reflect the new, leaner structure. (#478)

---

### ✅ Reliability & Bug Fixes

This release includes numerous fixes to improve stability, prevent errors, and enhance the overall reliability of the system.

- **State Management**:
  - Namespaced session state files to prevent context "bleeding" between different sessions. (#456)
  - Eliminated cross-session state leakage in the mode detection hooks for better isolation. (297fe42, 92432cf)
- **Concurrency & Race Conditions**:
  - Added a debounce mechanism to the compaction process to prevent errors from concurrent execution. (#453)
- **Tool & Hook Stability**:
  - Implemented a timeout-protected `stdin` in all hook scripts to prevent hangs. (#459)
- **API/Model Interaction**:
  - Added a fallback mechanism to handle `429 Too Many Requests` rate-limit errors from Codex and Gemini, improving resilience during heavy use. (#469)
- **Workflow Gates**:
  - Replaced the `AskUserQuestion` tool with a native Plan Mode approval gate in `ralplan` for a more streamlined and reliable human-in-the-loop workflow. (#448, #463)
- **Testing**:
  - Resolved merge conflicts and aligned skill/agent inventories in tests to match the consolidation changes. (e4d64a3, 539fb1a)
  - Fixed a test for stale lock file reaping by using `utimesSync` to correctly simulate file ages. (24455c3)