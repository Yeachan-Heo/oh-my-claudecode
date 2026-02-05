/**
 * Agent v4 Markdown Loader
 *
 * Loads role and shared section prompts from markdown files with
 * in-memory caching and frontmatter stripping.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
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

const NAME_ALLOWLIST = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");

function validateNameOrThrow(name: string, label: string): string {
  const normalized = name.toLowerCase();
  if (CONTROL_CHAR_PATTERN.test(name)) {
    throw new Error(`[${label}] Invalid name: contains control characters`);
  }
  if (
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("%2f") ||
    normalized.includes("%5c") ||
    normalized.includes("%2e")
  ) {
    throw new Error(`[${label}] Invalid name: path traversal detected`);
  }
  if (!NAME_ALLOWLIST.test(name)) {
    throw new Error(`[${label}] Invalid name: contains disallowed characters`);
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
    const resolvedBase = resolve(baseDir);
    const resolvedPath = resolve(filePath);
    const rel = relative(resolvedBase, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path traversal detected");
    }

    const realBase = existsSync(resolvedBase)
      ? realpathSync(resolvedBase)
      : resolvedBase;
    const targetPath = existsSync(resolvedPath)
      ? realpathSync(resolvedPath)
      : resolvedPath;
    const baseBoundary = realBase.endsWith(sep)
      ? realBase
      : `${realBase}${sep}`;
    if (!(targetPath === realBase || targetPath.startsWith(baseBoundary))) {
      throw new Error("path traversal detected");
    }

    const content = readFileSync(resolvedPath, "utf-8");
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

  const validatedRole = validateNameOrThrow(role, "loadRoleMarkdown");

  const rolesDir = join(getPackageDir(), "agents", "roles");
  const content = readMarkdownFile(rolesDir, validatedRole, "loadRoleMarkdown");
  const resolved = content ?? `Role: ${validatedRole}\n\nPrompt unavailable.`;
  roleCache.set(role, resolved);
  return resolved;
}

export function loadSectionMarkdown(sectionId: string): string {
  const cached = sectionCache.get(sectionId);
  if (cached) {
    return cached;
  }

  const validatedSection = validateNameOrThrow(
    sectionId,
    "loadSectionMarkdown",
  );

  const sectionsDir = join(getPackageDir(), "agents", "sections");
  const content = readMarkdownFile(
    sectionsDir,
    validatedSection,
    "loadSectionMarkdown",
  );
  const resolved =
    content ?? `Section: ${validatedSection}\n\nPrompt unavailable.`;
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
