import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { parseMock } = vi.hoisted(() => ({
  parseMock: vi.fn(() => ({
    root: () => ({
      findAll: () => [],
    }),
  })),
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

vi.mock("@ast-grep/napi", () => ({
  Lang: {
    TypeScript: "TypeScript",
  },
  parse: parseMock,
}));

import {
  astGrepReplaceTool,
  astGrepSearchTool,
} from "../../tools/ast-tools.js";

describe("ast tool runtime language validation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    parseMock.mockClear();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createSourceFile(extension: string, content: string): string {
    const directory = mkdtempSync(join(tmpdir(), "omc-ast-runtime-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, `sample${extension}`), content, "utf-8");
    return directory;
  }

  it("does not report an unavailable search language as no matches", async () => {
    const path = createSourceFile(".py", "import pandas as pd\n");

    const result = await astGrepSearchTool.handler({
      pattern: "import pandas as pd",
      language: "python",
      path,
    });

    expect(result.content[0]?.text).toContain(
      "Error in AST search: Unsupported language: python",
    );
    expect(result.content[0]?.text).not.toContain("No matches found");
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("does not report an unavailable replace language as no matches", async () => {
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
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("keeps supported languages on the normal per-file path", async () => {
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
});
