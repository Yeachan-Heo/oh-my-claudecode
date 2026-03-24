/**
 * Tests for Project Memory PreCompact Handler
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { processPreCompact, PreCompactInput } from "../pre-compact.js";
import { ProjectMemory } from "../types.js";
import { SCHEMA_VERSION } from "../constants.js";

vi.mock("../../rules-injector/finder.js", () => ({
  findProjectRoot: vi.fn(),
}));

vi.mock("../storage.js", () => ({
  loadProjectMemory: vi.fn(),
}));

import { findProjectRoot } from "../../rules-injector/finder.js";
import { loadProjectMemory } from "../storage.js";

const mockedFindProjectRoot = vi.mocked(findProjectRoot);
const mockedLoadProjectMemory = vi.mocked(loadProjectMemory);

const createBaseMemory = (
  overrides: Partial<ProjectMemory> = {},
): ProjectMemory => ({
  version: SCHEMA_VERSION,
  lastScanned: Date.now(),
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

const baseInput: PreCompactInput = {
  session_id: "test-session",
  transcript_path: "/tmp/transcript",
  cwd: "/test",
  permission_mode: "default",
  hook_event_name: "PreCompact",
  trigger: "auto",
};

describe("Project Memory PreCompact Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should treat customNotes as critical info and inject system message", async () => {
    mockedFindProjectRoot.mockReturnValue("/test");
    mockedLoadProjectMemory.mockResolvedValue(
      createBaseMemory({
        techStack: {
          languages: [
            {
              name: "TypeScript",
              version: null,
              confidence: "high",
              markers: ["tsconfig.json"],
            },
          ],
          frameworks: [],
          packageManager: "pnpm",
          runtime: null,
        },
        build: {
          buildCommand: "pnpm build",
          testCommand: "pnpm test",
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        customNotes: [
          {
            timestamp: Date.now(),
            source: "learned",
            category: "env",
            content: "Requires NODE_ENV",
          },
        ],
        userDirectives: [
          {
            timestamp: Date.now(),
            directive: "Stay in scope",
            context: "",
            source: "explicit",
            priority: "high",
          },
        ],
      }),
    );

    const result = await processPreCompact(baseInput);

    expect(result.continue).toBe(true);
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("Project Memory");
    expect(result.systemMessage).toContain("[Project Environment]");
    expect(result.systemMessage).toContain("[Directives]");
    expect(result.systemMessage).toContain("[Recent Learnings]");
  });

  it("should not inject when memory has no critical info", async () => {
    mockedFindProjectRoot.mockReturnValue("/test");
    mockedLoadProjectMemory.mockResolvedValue(createBaseMemory());

    const result = await processPreCompact(baseInput);

    expect(result.continue).toBe(true);
    expect(result.systemMessage).toBeUndefined();
  });
});
