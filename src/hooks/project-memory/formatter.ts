/**
 * Project Memory Formatter
 * Generates context strings for injection
 */

import path from "path";
import {
  ProjectMemory,
  FrameworkDetection,
  ProjectMemoryContext,
  CustomNote,
  UserDirective,
} from "./types.js";
import { getTopHotPaths } from "./hot-path-tracker.js";

const SUMMARY_CHAR_BUDGET = 650;
const MAX_HOT_PATH_ITEMS = 3;
const MAX_DIRECTIVE_ITEMS = 3;
const MAX_LEARNING_ITEMS = 3;

/**
 * Format project memory as a concise summary
 * Used for context injection (includes directives for compaction resilience)
 */
export function formatContextSummary(
  memory: ProjectMemory,
  context: ProjectMemoryContext = {},
): string {
  const lines: string[] = [];
  const pushTier = createBoundedTierWriter(lines);

  pushTier(formatEnvironmentTier(memory));
  pushTier(formatHotPathsTier(memory, context));
  pushTier(formatDirectivesTier(memory));
  pushTier(formatLearningsTier(memory, context));

  return trimToBudget(lines.join("\n"), SUMMARY_CHAR_BUDGET);
}

/**
 * Format project memory as full details (for debugging)
 */
export function formatFullContext(memory: ProjectMemory): string {
  const lines: string[] = [];

  lines.push("<project-memory>");
  lines.push("");
  lines.push("## Project Environment");
  lines.push("");

  if (memory.techStack.languages.length > 0) {
    lines.push("**Languages:**");
    for (const lang of memory.techStack.languages) {
      const version = lang.version ? ` (${lang.version})` : "";
      lines.push(`- ${lang.name}${version}`);
    }
    lines.push("");
  }

  if (memory.techStack.frameworks.length > 0) {
    lines.push("**Frameworks:**");
    for (const fw of memory.techStack.frameworks) {
      const version = fw.version ? ` (${fw.version})` : "";
      lines.push(`- ${fw.name}${version} [${fw.category}]`);
    }
    lines.push("");
  }

  const hasCommands =
    memory.build.buildCommand ||
    memory.build.testCommand ||
    memory.build.lintCommand;
  if (hasCommands) {
    lines.push("**Commands:**");
    if (memory.build.buildCommand) {
      lines.push(`- Build: \`${memory.build.buildCommand}\``);
    }
    if (memory.build.testCommand) {
      lines.push(`- Test: \`${memory.build.testCommand}\``);
    }
    if (memory.build.lintCommand) {
      lines.push(`- Lint: \`${memory.build.lintCommand}\``);
    }
    if (memory.build.devCommand) {
      lines.push(`- Dev: \`${memory.build.devCommand}\``);
    }
    lines.push("");
  }

  const hasConventions =
    memory.conventions.namingStyle ||
    memory.conventions.importStyle ||
    memory.conventions.testPattern;
  if (hasConventions) {
    if (memory.conventions.namingStyle) {
      lines.push(`**Code Style:** ${memory.conventions.namingStyle}`);
    }
    if (memory.conventions.importStyle) {
      lines.push(`**Import Style:** ${memory.conventions.importStyle}`);
    }
    if (memory.conventions.testPattern) {
      lines.push(`**Test Pattern:** ${memory.conventions.testPattern}`);
    }
    lines.push("");
  }

  if (memory.structure.isMonorepo) {
    lines.push("**Structure:** Monorepo");
    if (memory.structure.workspaces.length > 0) {
      lines.push(
        `- Workspaces: ${memory.structure.workspaces.slice(0, 3).join(", ")}`,
      );
    }
    lines.push("");
  }

  if (memory.customNotes.length > 0) {
    lines.push("**Custom Notes:**");
    for (const note of memory.customNotes.slice(0, 5)) {
      lines.push(`- [${note.category}] ${note.content}`);
    }
    lines.push("");
  }

  lines.push("</project-memory>");

  return lines.join("\n");
}

function formatEnvironmentTier(memory: ProjectMemory): string[] {
  const lines: string[] = [];
  const parts: string[] = [];

  const primaryLang =
    memory.techStack.languages
      .filter((l) => l.confidence === "high")
      .sort((a, b) => b.markers.length - a.markers.length)[0] ??
    memory.techStack.languages[0];

  if (primaryLang) {
    parts.push(primaryLang.name);
  }

  const primaryFramework = getPrimaryFramework(memory.techStack.frameworks);
  if (primaryFramework) {
    parts.push(primaryFramework.name);
  }

  if (memory.techStack.packageManager) {
    parts.push(`pkg:${memory.techStack.packageManager}`);
  }

  if (memory.techStack.runtime) {
    parts.push(memory.techStack.runtime);
  }

  if (parts.length === 0) {
    return lines;
  }

  lines.push("[Project Environment]");
  lines.push(`- ${parts.join(" | ")}`);

  const commands: string[] = [];
  if (memory.build.buildCommand)
    commands.push(`build=${memory.build.buildCommand}`);
  if (memory.build.testCommand)
    commands.push(`test=${memory.build.testCommand}`);
  if (memory.build.lintCommand)
    commands.push(`lint=${memory.build.lintCommand}`);
  if (commands.length > 0) {
    lines.push(`- ${commands.join(" | ")}`);
  }

  return lines;
}

function formatHotPathsTier(
  memory: ProjectMemory,
  context: ProjectMemoryContext,
): string[] {
  const topPaths = getTopHotPaths(memory.hotPaths, MAX_HOT_PATH_ITEMS, context);
  if (topPaths.length === 0) {
    return [];
  }

  const lines = ["[Hot Paths]"];
  for (const hotPath of topPaths) {
    lines.push(`- ${hotPath.path} (${hotPath.accessCount}x)`);
  }
  return lines;
}

function formatDirectivesTier(memory: ProjectMemory): string[] {
  const directives = [...memory.userDirectives]
    .sort((a, b) => scoreDirective(b) - scoreDirective(a))
    .slice(0, MAX_DIRECTIVE_ITEMS);

  if (directives.length === 0) {
    return [];
  }

  const lines = ["[Directives]"];
  for (const directive of directives) {
    const priority = directive.priority === "high" ? "critical" : "note";
    lines.push(`- ${priority}: ${directive.directive}`);
  }
  return lines;
}

function formatLearningsTier(
  memory: ProjectMemory,
  context: ProjectMemoryContext,
): string[] {
  const notes = [...memory.customNotes]
    .sort((a, b) => scoreLearning(b, context) - scoreLearning(a, context))
    .slice(0, MAX_LEARNING_ITEMS);

  if (notes.length === 0) {
    return [];
  }

  const lines = ["[Recent Learnings]"];
  for (const note of notes) {
    lines.push(`- [${note.category}] ${note.content}`);
  }
  return lines;
}

function createBoundedTierWriter(lines: string[]) {
  return (tierLines: string[]): void => {
    if (tierLines.length === 0) {
      return;
    }

    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(...tierLines);
  };
}

function trimToBudget(summary: string, budget: number): string {
  if (summary.length <= budget) {
    return summary;
  }

  return `${summary.slice(0, budget - 1).trimEnd()}…`;
}

function scoreDirective(directive: UserDirective): number {
  return (
    (directive.priority === "high" ? 1_000_000_000_000 : 0) +
    directive.timestamp
  );
}

function scoreLearning(
  note: CustomNote,
  context: ProjectMemoryContext,
): number {
  const categoryWeight: Record<string, number> = {
    env: 60,
    runtime: 50,
    dependency: 40,
    deploy: 30,
    test: 20,
  };

  const now = context.now ?? Date.now();
  const ageHours = Math.floor(
    Math.max(0, now - note.timestamp) / (60 * 60 * 1000),
  );
  const recencyWeight = Math.max(0, 100 - ageHours);
  const scopePath = normalizeScopePath(context.workingDirectory);
  const scopeBoost =
    scopePath && note.content.includes(scopePath.split("/").pop() ?? "")
      ? 10
      : 0;

  return recencyWeight + (categoryWeight[note.category] ?? 10) + scopeBoost;
}

function normalizeScopePath(workingDirectory?: string): string | null {
  if (!workingDirectory) {
    return null;
  }

  const normalized = path
    .normalize(workingDirectory)
    .replace(/^\.[/\\]?/, "")
    .replace(/\\/g, "/");
  if (normalized === "" || normalized === ".") {
    return null;
  }

  return normalized;
}

/**
 * Get the primary framework to highlight
 * Prefers frontend/fullstack, then by popularity
 */
function getPrimaryFramework(
  frameworks: FrameworkDetection[],
): FrameworkDetection | null {
  if (frameworks.length === 0) return null;

  const priority = ["fullstack", "frontend", "backend", "testing", "build"];

  for (const category of priority) {
    const match = frameworks.find((f) => f.category === category);
    if (match) return match;
  }

  return frameworks[0];
}
