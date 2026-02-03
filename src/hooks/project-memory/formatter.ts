/**
 * Project Memory Formatter
 * Generates context strings for injection
 */

import { ProjectMemory, FrameworkDetection } from './types.js';
import { formatDirectivesForContext } from './directive-detector.js';
import { getTopHotPaths } from './hot-path-tracker.js';

/**
 * Format project memory as a concise summary
 * Used for context injection (includes directives for compaction resilience)
 */
export function formatContextSummary(memory: ProjectMemory): string {
  const lines: string[] = [];

  // Always include user directives at the top (critical for compaction resilience)
  if (memory.userDirectives.length > 0) {
    const directivesText = formatDirectivesForContext(memory.userDirectives);
    lines.push(directivesText);
    lines.push('');
  }

  // Tech stack summary
  const parts: string[] = [];

  // Primary language
  const primaryLang = memory.techStack.languages
    .filter(l => l.confidence === 'high')
    .sort((a, b) => b.markers.length - a.markers.length)[0];

  if (primaryLang) {
    parts.push(primaryLang.name);
  }

  // Primary framework (prefer frontend/fullstack)
  const primaryFramework = getPrimaryFramework(memory.techStack.frameworks);
  if (primaryFramework) {
    parts.push(primaryFramework.name);
  }

  // Package manager
  if (memory.techStack.packageManager) {
    parts.push(`using ${memory.techStack.packageManager}`);
  }

  // Build command
  if (memory.build.buildCommand) {
    parts.push(`Build: ${memory.build.buildCommand}`);
  }

  // Test command
  if (memory.build.testCommand) {
    parts.push(`Test: ${memory.build.testCommand}`);
  }

  const techSummary = parts.join(' | ');

  // Add tech summary
  if (techSummary) {
    lines.push(`[Project Environment] ${techSummary}`);
  }

  // Add hot paths if available
  const topPaths = getTopHotPaths(memory.hotPaths, 5);
  if (topPaths.length > 0) {
    lines.push('');
    lines.push('**Frequently Accessed:**');
    for (const hp of topPaths) {
      lines.push(`- ${hp.path} (${hp.accessCount}x)`);
    }
  }

  // Add key directories
  const keyDirs = Object.values(memory.directoryMap)
    .filter(d => d.purpose)
    .slice(0, 5);
  if (keyDirs.length > 0) {
    lines.push('');
    lines.push('**Key Directories:**');
    for (const dir of keyDirs) {
      lines.push(`- ${dir.path}: ${dir.purpose}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format project memory as full details (for debugging)
 */
export function formatFullContext(memory: ProjectMemory): string {
  const lines: string[] = [];

  lines.push('<project-memory>');
  lines.push('');
  lines.push('## Project Environment');
  lines.push('');

  // Languages
  if (memory.techStack.languages.length > 0) {
    lines.push('**Languages:**');
    for (const lang of memory.techStack.languages) {
      const version = lang.version ? ` (${lang.version})` : '';
      lines.push(`- ${lang.name}${version}`);
    }
    lines.push('');
  }

  // Frameworks
  if (memory.techStack.frameworks.length > 0) {
    lines.push('**Frameworks:**');
    for (const fw of memory.techStack.frameworks) {
      const version = fw.version ? ` (${fw.version})` : '';
      lines.push(`- ${fw.name}${version} [${fw.category}]`);
    }
    lines.push('');
  }

  // Commands
  const hasCommands = memory.build.buildCommand || memory.build.testCommand || memory.build.lintCommand;
  if (hasCommands) {
    lines.push('**Commands:**');
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
    lines.push('');
  }

  // Conventions
  const hasConventions = memory.conventions.namingStyle || memory.conventions.importStyle || memory.conventions.testPattern;
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
    lines.push('');
  }

  // Structure
  if (memory.structure.isMonorepo) {
    lines.push('**Structure:** Monorepo');
    if (memory.structure.workspaces.length > 0) {
      lines.push(`- Workspaces: ${memory.structure.workspaces.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }

  // Custom notes
  if (memory.customNotes.length > 0) {
    lines.push('**Custom Notes:**');
    for (const note of memory.customNotes.slice(0, 5)) {
      lines.push(`- [${note.category}] ${note.content}`);
    }
    lines.push('');
  }

  lines.push('</project-memory>');

  return lines.join('\n');
}

/**
 * Get the primary framework to highlight
 * Prefers frontend/fullstack, then by popularity
 */
function getPrimaryFramework(frameworks: FrameworkDetection[]): FrameworkDetection | null {
  if (frameworks.length === 0) return null;

  // Priority order: fullstack > frontend > backend > testing > build
  const priority = ['fullstack', 'frontend', 'backend', 'testing', 'build'];

  for (const category of priority) {
    const match = frameworks.find(f => f.category === category);
    if (match) return match;
  }

  return frameworks[0];
}
