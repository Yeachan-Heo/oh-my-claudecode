import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { parseMock, runtimeLoadMock } = vi.hoisted(() => ({
  parseMock: vi.fn(),
  runtimeLoadMock: vi.fn(),
}));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("module")>();
  return {
    ...actual,
    createRequire: () => {
      throw new Error("force dynamic import fallback");
    },
  };
});

vi.mock("@ast-grep/napi", () => runtimeLoadMock());

function createRuntime(languages: Record<string, string>) {
  return {
    Lang: languages,
    parse: parseMock,
  };
}

async function loadAstTools() {
  return import("../../tools/ast-tools.js");
}

function expectRecoveryGuidance(text: string | undefined): void {
  expect(text).toContain("npm install -g @ast-grep/napi@0.31");
  expect(text).toContain("restart Claude Code (or the MCP server)");
}

describe("ast tool runtime language validation", () => {
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    parseMock.mockReset();
    parseMock.mockImplementation(() => ({
      root: () => ({
        findAll: () => [],
      }),
    }));
    runtimeLoadMock.mockReset();
    runtimeLoadMock.mockReturnValue(
      createRuntime({
        TypeScript: "TypeScript",
        Python: "Python",
      }),
    );
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  function createSourceFile(extension: string, content: string): string {
    const directory = mkdtempSync(join(tmpdir(), "omc-ast-runtime-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, `sample${extension}`), content, "utf-8");
    return directory;
  }

  it("reports missing-module recovery guidance and caches the failed load", async () => {
    runtimeLoadMock.mockImplementation(() => {
      throw new Error("simulated missing package");
    });
    const { astGrepSearchTool } = await loadAstTools();
    const path = createSourceFile(".ts", "const value = 1;\n");

    const firstResult = await astGrepSearchTool.handler({
      pattern: "const $NAME = $VALUE",
      language: "typescript",
      path,
    });

    expect(firstResult.content[0]?.text).toContain(
      "@ast-grep/napi is not available",
    );
    expectRecoveryGuidance(firstResult.content[0]?.text);

    runtimeLoadMock.mockReturnValue(
      createRuntime({ TypeScript: "TypeScript" }),
    );
    const cachedResult = await astGrepSearchTool.handler({
      pattern: "const $NAME = $VALUE",
      language: "typescript",
      path,
    });

    expect(cachedResult.content[0]?.text).toBe(firstResult.content[0]?.text);
    expect(runtimeLoadMock).toHaveBeenCalledOnce();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("uses the same missing-module recovery guidance for replace", async () => {
    runtimeLoadMock.mockImplementation(() => {
      throw new Error("simulated missing package");
    });
    const { astGrepReplaceTool } = await loadAstTools();
    const path = createSourceFile(".ts", "const value = 1;\n");

    const result = await astGrepReplaceTool.handler({
      pattern: "const $NAME = $VALUE",
      replacement: "let $NAME = $VALUE",
      language: "typescript",
      path,
    });

    expect(result.content[0]?.text).toContain(
      "@ast-grep/napi is not available",
    );
    expectRecoveryGuidance(result.content[0]?.text);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("reports unsupported search language recovery and caches the loaded runtime", async () => {
    runtimeLoadMock.mockReturnValue(
      createRuntime({ TypeScript: "TypeScript" }),
    );
    const { astGrepSearchTool } = await loadAstTools();
    const path = createSourceFile(".py", "import pandas as pd\n");

    const firstResult = await astGrepSearchTool.handler({
      pattern: "import pandas as pd",
      language: "python",
      path,
    });

    expect(firstResult.content[0]?.text).toContain(
      "Error in AST search: Unsupported language: python",
    );
    expect(firstResult.content[0]?.text).not.toContain("No matches found");
    expectRecoveryGuidance(firstResult.content[0]?.text);

    runtimeLoadMock.mockReturnValue(
      createRuntime({ TypeScript: "TypeScript", Python: "Python" }),
    );
    const cachedResult = await astGrepSearchTool.handler({
      pattern: "import pandas as pd",
      language: "python",
      path,
    });

    expect(cachedResult.content[0]?.text).toBe(firstResult.content[0]?.text);
    expect(runtimeLoadMock).toHaveBeenCalledOnce();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("reports unsupported replace language recovery instead of no matches", async () => {
    runtimeLoadMock.mockReturnValue(
      createRuntime({ TypeScript: "TypeScript" }),
    );
    const { astGrepReplaceTool } = await loadAstTools();
    const path = createSourceFile(".py", "print('before')\n");

    const result = await astGrepReplaceTool.handler({
      pattern: "print($ARG)",
      replacement: "logger.info($ARG)",
      language: "python",
      path,
    });

    expect(result.content[0]?.text).toContain(
      "Error in AST replace: Unsupported language: python",
    );
    expect(result.content[0]?.text).not.toContain("No matches found");
    expectRecoveryGuidance(result.content[0]?.text);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("preserves genuine search no-match behavior for a supported language", async () => {
    const { astGrepSearchTool } = await loadAstTools();
    const path = createSourceFile(".ts", "const value = 1;\n");

    const result = await astGrepSearchTool.handler({
      pattern: "const $NAME = $VALUE",
      language: "typescript",
      path,
    });

    expect(result.content[0]?.text).toContain("No matches found");
    expect(result.content[0]?.text).not.toContain("Unsupported language");
    expect(parseMock).toHaveBeenCalledOnce();
  });

  it("preserves genuine replace no-match behavior for a supported language", async () => {
    const { astGrepReplaceTool } = await loadAstTools();
    const path = createSourceFile(".ts", "const value = 1;\n");

    const result = await astGrepReplaceTool.handler({
      pattern: "console.log($VALUE)",
      replacement: "logger.info($VALUE)",
      language: "typescript",
      path,
    });

    expect(result.content[0]?.text).toContain("No matches found");
    expect(result.content[0]?.text).not.toContain("Unsupported language");
    expect(parseMock).toHaveBeenCalledOnce();
  });
});
