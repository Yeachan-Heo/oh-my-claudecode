import { describe, expect, it } from "vitest";
import {
  createMagicKeywordProcessor,
  detectMagicKeywords,
} from "../features/magic-keywords.js";

describe("magic keyword regex safety", () => {
  it("detects escaped punctuation triggers literally without regex injection", () => {
    // c++ trigger should match literally, not as regex quantifier
    expect(
      detectMagicKeywords("please c++ this", { ultrawork: ["c++"] }),
    ).toEqual(["c++"]);
    // Regex-like trigger should be treated as literal text
    expect(
      detectMagicKeywords("please (.*){10} this", { ultrawork: ["(.*){10}"] }),
    ).toEqual(["(.*){10}"]);
  });

  it("processes punctuation triggers without throwing or compiling attacker regex", () => {
    const processPrompt = createMagicKeywordProcessor({ ultrawork: ["c++"] });
    expect(() => processPrompt("c++ fix this")).not.toThrow();
    const result = processPrompt("c++ fix this");
    expect(result).toContain("ultrawork-mode");
  });

  it("does not match punctuation triggers inside larger word characters", () => {
    // "xc++y" should NOT match because c++ is surrounded by word chars
    expect(detectMagicKeywords("xc++y", { ultrawork: ["c++"] })).toEqual([]);
  });

  it("matches punctuation triggers at word boundaries", () => {
    // c++ at start of string
    expect(detectMagicKeywords("c++ rocks", { ultrawork: ["c++"] })).toEqual([
      "c++",
    ]);
    // c++ at end of string
    expect(detectMagicKeywords("I love c++", { ultrawork: ["c++"] })).toEqual([
      "c++",
    ]);
    // c++ surrounded by spaces
    expect(detectMagicKeywords("use c++ here", { ultrawork: ["c++"] })).toEqual(
      ["c++"],
    );
    // c++ next to punctuation (comma)
    expect(detectMagicKeywords("c++, Java", { ultrawork: ["c++"] })).toEqual([
      "c++",
    ]);
  });

  it("removes punctuation triggers from the ultrawork-cleaned portion", () => {
    const processPrompt = createMagicKeywordProcessor({ ultrawork: ["c++"] });
    const result = processPrompt("c++ fix the bug");
    // Ultrawork mode should be activated (trigger was detected and processed)
    expect(result).toContain("ultrawork-mode");
    // The cleaned portion (after trigger removal) should contain the rest of the prompt
    expect(result).toContain("fix the bug");
  });

  it("still detects normal word triggers correctly", () => {
    expect(detectMagicKeywords("ultrawork fix all errors", {})).toEqual([
      "ultrawork",
    ]);
    expect(detectMagicKeywords("ulw do this", {})).toEqual(["ulw"]);
  });

  it("does not match normal triggers inside larger words", () => {
    // "ultraworking" should not match "ultrawork"
    expect(detectMagicKeywords("ultraworking hard", {})).toEqual([]);
  });

  it("skips triggers in informational/question context", () => {
    expect(detectMagicKeywords("what is ultrawork?", {})).toEqual([]);
    expect(detectMagicKeywords("ultrawork 뭐야?", {})).toEqual([]);
  });
});
