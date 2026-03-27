/**
 * Tests for Project Memory Formatter
 */
import { describe, it, expect } from "vitest";
import { formatContextSummary, formatFullContext } from "../formatter.js";
import { SCHEMA_VERSION } from "../constants.js";
const NOW = Date.parse("2026-03-24T15:00:00Z");
// Helper to create base memory with all required fields
const createBaseMemory = (overrides = {}) => ({
    version: SCHEMA_VERSION,
    lastScanned: NOW,
    projectRoot: "/test",
    techStack: {
        languages: [],
        frameworks: [],
        packageManager: null,
        runtime: null,
    },
    build: {
        buildCommand: null,
        testCommand: null,
        lintCommand: null,
        devCommand: null,
        scripts: {},
    },
    conventions: {
        namingStyle: null,
        importStyle: null,
        testPattern: null,
        fileOrganization: null,
    },
    structure: {
        isMonorepo: false,
        workspaces: [],
        mainDirectories: [],
        gitBranches: null,
    },
    customNotes: [],
    directoryMap: {},
    hotPaths: [],
    userDirectives: [],
    ...overrides,
});
describe("Project Memory Formatter", () => {
    describe("formatContextSummary", () => {
        it("formats the summary in progressive disclosure order", () => {
            const memory = createBaseMemory({
                techStack: {
                    languages: [
                        {
                            name: "TypeScript",
                            version: "5.0.0",
                            confidence: "high",
                            markers: ["tsconfig.json"],
                        },
                    ],
                    frameworks: [
                        { name: "next", version: "14.0.0", category: "fullstack" },
                    ],
                    packageManager: "pnpm",
                    runtime: "Node.js 20.0.0",
                },
                build: {
                    buildCommand: "pnpm build",
                    testCommand: "pnpm test",
                    lintCommand: "pnpm lint",
                    devCommand: null,
                    scripts: {},
                },
                hotPaths: [
                    {
                        path: "src/hooks/project-memory/index.ts",
                        accessCount: 5,
                        lastAccessed: NOW,
                        type: "file",
                    },
                ],
                userDirectives: [
                    {
                        timestamp: NOW,
                        directive: "Keep changes in src/hooks/project-memory",
                        context: "",
                        source: "explicit",
                        priority: "high",
                    },
                ],
                customNotes: [
                    {
                        timestamp: NOW,
                        source: "learned",
                        category: "runtime",
                        content: "Node.js v20.10.0",
                    },
                ],
            });
            const summary = formatContextSummary(memory, {
                workingDirectory: "src/hooks/project-memory",
                now: NOW,
            });
            expect(summary.indexOf("[Project Environment]")).toBeLessThan(summary.indexOf("[Hot Paths]"));
            expect(summary.indexOf("[Hot Paths]")).toBeLessThan(summary.indexOf("[Directives]"));
            expect(summary.indexOf("[Directives]")).toBeLessThan(summary.indexOf("[Recent Learnings]"));
        });
        it("keeps the summary bounded", () => {
            const memory = createBaseMemory({
                techStack: {
                    languages: [
                        {
                            name: "TypeScript",
                            version: "5.0.0",
                            confidence: "high",
                            markers: ["tsconfig.json"],
                        },
                    ],
                    frameworks: [
                        { name: "next", version: "14.0.0", category: "fullstack" },
                        { name: "vitest", version: "2.0.0", category: "testing" },
                    ],
                    packageManager: "pnpm",
                    runtime: "Node.js 20.0.0",
                },
                build: {
                    buildCommand: "pnpm build --mode production --minify --long-flag really-long-value",
                    testCommand: "pnpm test --runInBand --coverage --reporter verbose",
                    lintCommand: "pnpm lint --max-warnings=0 --fix",
                    devCommand: "pnpm dev",
                    scripts: {},
                },
                hotPaths: Array.from({ length: 6 }, (_, index) => ({
                    path: `src/feature-${index}/very/deep/file-${index}.ts`,
                    accessCount: 10 - index,
                    lastAccessed: NOW - index * 1000,
                    type: "file",
                })),
                userDirectives: Array.from({ length: 5 }, (_, index) => ({
                    timestamp: NOW - index,
                    directive: `Critical directive ${index} with verbose explanation`,
                    context: "",
                    source: "explicit",
                    priority: index === 0 ? "high" : "normal",
                })),
                customNotes: Array.from({ length: 5 }, (_, index) => ({
                    timestamp: NOW - index * 1000,
                    source: "learned",
                    category: "env",
                    content: `Learning ${index} with lots of additional detail to stress output truncation`,
                })),
            });
            const summary = formatContextSummary(memory, { now: NOW });
            expect(summary.length).toBeLessThanOrEqual(650);
            expect(summary).toContain("[Project Environment]");
        });
        it("prefers hot paths near the current working directory", () => {
            const memory = createBaseMemory({
                hotPaths: [
                    {
                        path: "docs/guide.md",
                        accessCount: 20,
                        lastAccessed: NOW - 60_000,
                        type: "file",
                    },
                    {
                        path: "src/hooks/project-memory/formatter.ts",
                        accessCount: 5,
                        lastAccessed: NOW - 60_000,
                        type: "file",
                    },
                    {
                        path: "src/hooks/project-memory/index.ts",
                        accessCount: 4,
                        lastAccessed: NOW - 60_000,
                        type: "file",
                    },
                ],
            });
            const summary = formatContextSummary(memory, {
                workingDirectory: "src/hooks/project-memory",
                now: NOW,
            });
            const hotPathsSection = summary.split("[Hot Paths]")[1] ?? "";
            expect(hotPathsSection.indexOf("src/hooks/project-memory/formatter.ts")).toBeLessThan(hotPathsSection.indexOf("docs/guide.md"));
        });
        it("prioritizes high priority directives and recent learnings", () => {
            const memory = createBaseMemory({
                userDirectives: [
                    {
                        timestamp: NOW - 10_000,
                        directive: "use concise output",
                        context: "",
                        source: "explicit",
                        priority: "normal",
                    },
                    {
                        timestamp: NOW - 20_000,
                        directive: "stay inside src/hooks/project-memory",
                        context: "",
                        source: "explicit",
                        priority: "high",
                    },
                ],
                customNotes: [
                    {
                        timestamp: NOW - 50_000,
                        source: "learned",
                        category: "test",
                        content: "Old test note",
                    },
                    {
                        timestamp: NOW - 1_000,
                        source: "learned",
                        category: "env",
                        content: "Fresh env note",
                    },
                ],
            });
            const summary = formatContextSummary(memory, { now: NOW });
            const directivesSection = summary.split("[Directives]")[1]?.split("[Recent Learnings]")[0] ?? "";
            const learningsSection = summary.split("[Recent Learnings]")[1] ?? "";
            expect(directivesSection.indexOf("stay inside src/hooks/project-memory")).toBeLessThan(directivesSection.indexOf("use concise output"));
            expect(learningsSection.indexOf("Fresh env note")).toBeLessThan(learningsSection.indexOf("Old test note"));
        });
        it("skips empty tiers without leaving extra headings", () => {
            const memory = createBaseMemory({
                techStack: {
                    languages: [
                        {
                            name: "Rust",
                            version: null,
                            confidence: "high",
                            markers: ["Cargo.toml"],
                        },
                    ],
                    frameworks: [],
                    packageManager: "cargo",
                    runtime: null,
                },
                build: {
                    buildCommand: "cargo build",
                    testCommand: "cargo test",
                    lintCommand: null,
                    devCommand: null,
                    scripts: {},
                },
            });
            const summary = formatContextSummary(memory, { now: NOW });
            expect(summary).toContain("[Project Environment]");
            expect(summary).not.toContain("[Hot Paths]");
            expect(summary).not.toContain("[Directives]");
            expect(summary).not.toContain("[Recent Learnings]");
        });
    });
    describe("formatFullContext", () => {
        it("should format complete project details", () => {
            const memory = createBaseMemory({
                techStack: {
                    languages: [
                        {
                            name: "TypeScript",
                            version: "5.0.0",
                            confidence: "high",
                            markers: ["tsconfig.json"],
                        },
                    ],
                    frameworks: [
                        { name: "react", version: "18.2.0", category: "frontend" },
                    ],
                    packageManager: "pnpm",
                    runtime: "Node.js 20.0.0",
                },
                build: {
                    buildCommand: "pnpm build",
                    testCommand: "pnpm test",
                    lintCommand: "pnpm lint",
                    devCommand: "pnpm dev",
                    scripts: {},
                },
                conventions: {
                    namingStyle: "camelCase",
                    importStyle: "ES modules",
                    testPattern: "*.test.ts",
                    fileOrganization: "feature-based",
                },
                structure: {
                    isMonorepo: true,
                    workspaces: ["packages/*"],
                    mainDirectories: ["src", "tests"],
                    gitBranches: { defaultBranch: "main", branchingStrategy: null },
                },
                customNotes: [
                    {
                        timestamp: NOW,
                        source: "learned",
                        category: "env",
                        content: "Requires NODE_ENV",
                    },
                ],
            });
            const full = formatFullContext(memory);
            expect(full).toContain("<project-memory>");
            expect(full).toContain("## Project Environment");
            expect(full).toContain("**Languages:**");
            expect(full).toContain("TypeScript (5.0.0)");
            expect(full).toContain("**Frameworks:**");
            expect(full).toContain("react (18.2.0) [frontend]");
            expect(full).toContain("**Commands:**");
            expect(full).toContain("Build: `pnpm build`");
            expect(full).toContain("**Code Style:** camelCase");
            expect(full).toContain("**Structure:** Monorepo");
            expect(full).toContain("**Custom Notes:**");
            expect(full).toContain("[env] Requires NODE_ENV");
            expect(full).toContain("</project-memory>");
        });
    });
});
//# sourceMappingURL=formatter.test.js.map