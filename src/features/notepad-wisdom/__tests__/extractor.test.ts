import { describe, expect, it } from "vitest";
import { extractWisdomFromCompletion } from "../extractor.js";

describe("extractWisdomFromCompletion", () => {
  it("round-trips multi-line content from singular wisdom tags", () => {
    const response = "<learning>line one\nline two</learning>";

    expect(extractWisdomFromCompletion(response)).toEqual([
      { category: "learnings", content: "line one\nline two" },
    ]);
  });

  it("captures singular-tag content containing characters beyond s and S", () => {
    const response = "<decision>adopt the stable parser</decision>";

    expect(extractWisdomFromCompletion(response)).toEqual([
      { category: "decisions", content: "adopt the stable parser" },
    ]);
  });
});
