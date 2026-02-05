/**
 * Agent v4 Role Definitions
 *
 * Canonical role metadata and defaults.
 */

import type { AgentRole, AgentRoleDefinition } from "./types.js";

const rolePromptPlaceholder = (role: AgentRole): string =>
  `Role-specific prompt loaded from agents/roles/${role}.md`;

/**
 * Canonical role definitions for all base agents.
 */
export const AGENT_ROLES: Record<AgentRole, AgentRoleDefinition> = {
  architect: {
    role: "architect",
    description:
      "Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems and high-difficulty architecture design.",
    defaultTier: "HIGH",
    baseTools: [
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "lsp_diagnostics",
      "lsp_diagnostics_directory",
      "ast_grep_search",
    ],
    category: "advisor",
    rolePrompt: rolePromptPlaceholder("architect"),
    readOnly: true,
  },
  researcher: {
    role: "researcher",
    description:
      "Documentation researcher and external reference finder. Use for official docs, GitHub examples, OSS implementations, API references. Searches EXTERNAL resources, not internal codebase.",
    defaultTier: "MEDIUM",
    baseTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    category: "specialist",
    rolePrompt: rolePromptPlaceholder("researcher"),
    readOnly: true,
  },
  explore: {
    role: "explore",
    description:
      "Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase.",
    defaultTier: "LOW",
    baseTools: ["Read", "Glob", "Grep"],
    category: "exploration",
    rolePrompt: rolePromptPlaceholder("explore"),
    readOnly: true,
  },
  designer: {
    role: "designer",
    description:
      "Designer-turned-developer who crafts stunning UI/UX even without design mockups. Use for VISUAL changes only (styling, layout, animation). Pure logic changes in frontend files should be handled directly.",
    defaultTier: "MEDIUM",
    baseTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    category: "specialist",
    rolePrompt: rolePromptPlaceholder("designer"),
    readOnly: false,
  },
  writer: {
    role: "writer",
    description:
      "Technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides.",
    defaultTier: "LOW",
    baseTools: ["Read", "Glob", "Grep", "Edit", "Write"],
    category: "utility",
    rolePrompt: rolePromptPlaceholder("writer"),
    readOnly: false,
  },
  vision: {
    role: "vision",
    description:
      "Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text. Extracts specific information or summaries from documents, describes visual content.",
    defaultTier: "MEDIUM",
    baseTools: ["Read", "Glob", "Grep"],
    category: "advisor",
    rolePrompt: rolePromptPlaceholder("vision"),
    readOnly: true,
  },
  critic: {
    role: "critic",
    description:
      "Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards. Use after planner creates a work plan to validate it before execution.",
    defaultTier: "HIGH",
    baseTools: ["Read", "Glob", "Grep"],
    category: "reviewer",
    rolePrompt: rolePromptPlaceholder("critic"),
    readOnly: true,
  },
  analyst: {
    role: "analyst",
    description:
      "Pre-planning consultant that analyzes requests before implementation to identify hidden requirements, edge cases, and potential risks. Use before creating a work plan.",
    defaultTier: "HIGH",
    baseTools: ["Read", "Glob", "Grep", "WebSearch"],
    category: "planner",
    rolePrompt: rolePromptPlaceholder("analyst"),
    readOnly: true,
  },
  executor: {
    role: "executor",
    description:
      "Focused task executor. Execute tasks directly. NEVER delegate or spawn other agents. Same discipline as Sisyphus, no delegation.",
    defaultTier: "MEDIUM",
    baseTools: [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash",
      "TodoWrite",
      "lsp_diagnostics",
    ],
    category: "specialist",
    rolePrompt: rolePromptPlaceholder("executor"),
    readOnly: false,
  },
  planner: {
    role: "planner",
    description:
      "Strategic planning consultant. Interviews users to understand requirements, then creates comprehensive work plans. NEVER implements - only plans.",
    defaultTier: "HIGH",
    baseTools: ["Read", "Glob", "Grep", "WebSearch"],
    category: "planner",
    rolePrompt: rolePromptPlaceholder("planner"),
    readOnly: true,
  },
  "qa-tester": {
    role: "qa-tester",
    description:
      "Interactive CLI testing specialist using tmux. Tests CLI applications, background services, and interactive tools. Manages test sessions, sends commands, verifies output, and ensures cleanup.",
    defaultTier: "MEDIUM",
    baseTools: ["Bash", "Read", "Grep", "Glob", "TodoWrite", "lsp_diagnostics"],
    category: "specialist",
    rolePrompt: rolePromptPlaceholder("qa-tester"),
    readOnly: false,
  },
  scientist: {
    role: "scientist",
    description:
      "Data analysis and research execution specialist. Executes Python code for EDA, statistical analysis, and generating data-driven findings. Works with CSV, JSON, Parquet files using pandas, numpy, scipy.",
    defaultTier: "MEDIUM",
    baseTools: ["Read", "Glob", "Grep", "Bash", "python_repl"],
    category: "specialist",
    rolePrompt: rolePromptPlaceholder("scientist"),
    readOnly: false,
  },
};

/**
 * Get the role definition for a specific agent role.
 */
export function getAgentRole(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLES[role];
}
