/**
 * Agent v4 Markdown Loader
 *
 * Loads role and shared section prompts from markdown files with
 * in-memory caching and frontmatter stripping.
 */

import { readFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import type { AgentRole, PromptSection } from "./types.js";

const roleCache = new Map<AgentRole, string>();
const sectionCache = new Map<string, string>();

const SECTION_IDS = [
  "base-protocol",
  "tier-low",
  "tier-medium",
  "tier-high",
  "verification-protocol",
  "escalation-protocol",
];

const SECTION_ORDER: Record<string, number> = {
  "base-protocol": 0,
  "tier-low": 10,
  "tier-medium": 10,
  "tier-high": 10,
  "verification-protocol": 20,
  "escalation-protocol": 30,
};

function getPackageDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "..", "..");
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function formatSectionName(sectionId: string): string {
  return sectionId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function validateName(name: string, label: string): string | null {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    console.warn(`[${label}] Invalid name: contains disallowed characters`);
    return null;
  }
  return name;
}

function readMarkdownFile(
  baseDir: string,
  fileName: string,
  label: string,
): string | null {
  try {
    const filePath = join(baseDir, `${fileName}.md`);
    const resolvedPath = resolve(filePath);
    const resolvedBase = resolve(baseDir);
    const rel = relative(resolvedBase, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path traversal detected");
    }

    const content = readFileSync(filePath, "utf-8");
    return stripFrontmatter(content);
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("path traversal")
        ? "Invalid name: path traversal detected"
        : "Markdown file not found";
    console.warn(`[${label}] ${message}`);
    return null;
  }
}

export function loadRoleMarkdown(role: AgentRole): string {
  const cached = roleCache.get(role);
  if (cached) {
    return cached;
  }

  if (!validateName(role, "loadRoleMarkdown")) {
    return `Role: ${role}\n\nPrompt unavailable.`;
  }

  const rolesDir = join(getPackageDir(), "agents", "roles");
  const content = readMarkdownFile(rolesDir, role, "loadRoleMarkdown");
  const resolved = content ?? `Role: ${role}\n\nPrompt unavailable.`;
  roleCache.set(role, resolved);
  return resolved;
}

export function loadSectionMarkdown(sectionId: string): string {
  const cached = sectionCache.get(sectionId);
  if (cached) {
    return cached;
  }

  if (!validateName(sectionId, "loadSectionMarkdown")) {
    return `Section: ${sectionId}\n\nPrompt unavailable.`;
  }

  const sectionsDir = join(getPackageDir(), "agents", "sections");
  const content = readMarkdownFile(
    sectionsDir,
    sectionId,
    "loadSectionMarkdown",
  );
  const resolved = content ?? `Section: ${sectionId}\n\nPrompt unavailable.`;
  sectionCache.set(sectionId, resolved);
  return resolved;
}

export function loadAllSections(): PromptSection[] {
  return SECTION_IDS.map((sectionId) => {
    const content = loadSectionMarkdown(sectionId);
    return {
      id: sectionId,
      name: formatSectionName(sectionId),
      content,
      order: SECTION_ORDER[sectionId] ?? 100,
    };
  });
}

export function clearLoaderCache(): void {
  roleCache.clear();
  sectionCache.clear();
}
