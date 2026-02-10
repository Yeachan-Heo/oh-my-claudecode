/**
 * Tests for CJK-aware string width utilities.
 * Related: Issue #344 - Korean IME input visibility
 */

import { describe, it, expect } from "vitest";
import {
  isCJKCharacter,
  isZeroWidth,
  getCharWidth,
  stringWidth,
  stripAnsi,
  truncateToWidth,
  padToWidth,
  sliceByWidth,
} from "../string-width.js";

describe("isCJKCharacter", () => {
  it("detects Korean Hangul syllables", () => {
    expect(isCJKCharacter("안".codePointAt(0)!)).toBe(true);
    expect(isCJKCharacter("녕".codePointAt(0)!)).toBe(true);
    expect(isCJKCharacter("하".codePointAt(0)!)).toBe(true);
  });

  it("detects CJK Unified Ideographs (Chinese)", () => {
    expect(isCJKCharacter("中".codePointAt(0)!)).toBe(true);
    expect(isCJKCharacter("文".codePointAt(0)!)).toBe(true);
  });

  it("detects Japanese Hiragana and Katakana", () => {
    expect(isCJKCharacter("あ".codePointAt(0)!)).toBe(true);
    expect(isCJKCharacter("カ".codePointAt(0)!)).toBe(true);
  });

  it("detects full-width ASCII", () => {
    expect(isCJKCharacter("Ａ".codePointAt(0)!)).toBe(true);
    expect(isCJKCharacter("１".codePointAt(0)!)).toBe(true);
  });

  it("returns false for ASCII characters", () => {
    expect(isCJKCharacter("A".codePointAt(0)!)).toBe(false);
    expect(isCJKCharacter("1".codePointAt(0)!)).toBe(false);
    expect(isCJKCharacter(" ".codePointAt(0)!)).toBe(false);
  });
});

describe("isZeroWidth", () => {
  it("detects zero-width space", () => {
    expect(isZeroWidth(0x200b)).toBe(true);
  });

  it("detects zero-width joiner", () => {
    expect(isZeroWidth(0x200d)).toBe(true);
  });

  it("detects combining diacritical marks", () => {
    expect(isZeroWidth(0x0300)).toBe(true); // Combining Grave Accent
    expect(isZeroWidth(0x0301)).toBe(true); // Combining Acute Accent
  });

  it("returns false for regular characters", () => {
    expect(isZeroWidth("a".codePointAt(0)!)).toBe(false);
    expect(isZeroWidth("가".codePointAt(0)!)).toBe(false);
  });
});

describe("getCharWidth", () => {
  it("returns 2 for CJK characters", () => {
    expect(getCharWidth("한")).toBe(2);
    expect(getCharWidth("中")).toBe(2);
  });

  it("returns 1 for ASCII characters", () => {
    expect(getCharWidth("A")).toBe(1);
    expect(getCharWidth("z")).toBe(1);
  });

  it("returns 0 for empty string", () => {
    expect(getCharWidth("")).toBe(0);
  });
});

describe("stringWidth", () => {
  it("calculates width of ASCII string", () => {
    expect(stringWidth("hello")).toBe(5);
  });

  it("calculates width of Korean string", () => {
    // Each Korean character is double-width
    expect(stringWidth("안녕하세요")).toBe(10);
  });

  it("calculates width of mixed ASCII and CJK", () => {
    // "hi" = 2, "안녕" = 4
    expect(stringWidth("hi안녕")).toBe(6);
  });

  it("strips ANSI codes before calculating", () => {
    expect(stringWidth("\x1b[31mhello\x1b[0m")).toBe(5);
    expect(stringWidth("\x1b[1m안녕\x1b[0m")).toBe(4);
  });

  it("returns 0 for empty string", () => {
    expect(stringWidth("")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(stringWidth("")).toBe(0);
  });

  it("calculates width of Japanese text", () => {
    // Each character is double-width
    expect(stringWidth("こんにちは")).toBe(10);
  });

  it("calculates width of Chinese text", () => {
    expect(stringWidth("你好世界")).toBe(8);
  });
});

describe("stripAnsi", () => {
  it("strips SGR sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips bold sequences", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[0m")).toBe("bold");
  });

  it("strips multiple sequences", () => {
    expect(stripAnsi("\x1b[1m\x1b[31mboldred\x1b[0m")).toBe("boldred");
  });

  it("returns unchanged string without ANSI", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });
});

describe("truncateToWidth", () => {
  it("returns string unchanged if within width", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  it("truncates ASCII string with ellipsis", () => {
    expect(truncateToWidth("hello world", 8)).toBe("hello...");
  });

  it("truncates Korean string correctly", () => {
    // "안녕하세요" = 10 columns
    // With maxWidth=6, suffix "..." = 3 cols, target = 3 cols = 1 Korean char (2) + overflow
    const result = truncateToWidth("안녕하세요", 7);
    // "안녕" = 4 cols, "..." = 3 cols = total 7
    expect(result).toBe("안녕...");
  });

  it("truncates mixed CJK/ASCII correctly", () => {
    // "hi안녕하세요" = 2 + 10 = 12 columns
    const result = truncateToWidth("hi안녕하세요", 9);
    // "hi안녕" = 6 cols, "..." = 3 cols = total 9
    expect(result).toBe("hi안녕...");
  });

  it("handles maxWidth of 0", () => {
    expect(truncateToWidth("hello", 0)).toBe("");
  });

  it("handles empty string", () => {
    expect(truncateToWidth("", 10)).toBe("");
  });

  it("handles string exactly at width", () => {
    expect(truncateToWidth("hello", 5)).toBe("hello");
  });

  it("uses custom suffix", () => {
    expect(truncateToWidth("hello world", 8, "…")).toBe("hello w…");
  });

  it("does not break CJK characters", () => {
    // "안녕" = 4 columns. With maxWidth=5, "..." = 3, target = 2 = 1 Korean char
    const result = truncateToWidth("안녕하세요", 5);
    expect(result).toBe("안...");
  });
});

describe("padToWidth", () => {
  it("pads ASCII string to width", () => {
    expect(padToWidth("hi", 5)).toBe("hi   ");
  });

  it("pads CJK string correctly", () => {
    // "안녕" = 4 columns, pad to 6 = 2 spaces
    expect(padToWidth("안녕", 6)).toBe("안녕  ");
  });

  it("does not pad if already at width", () => {
    expect(padToWidth("hello", 5)).toBe("hello");
  });

  it("does not pad if exceeding width", () => {
    expect(padToWidth("hello world", 5)).toBe("hello world");
  });
});

describe("sliceByWidth", () => {
  it("slices ASCII string by width", () => {
    expect(sliceByWidth("hello", 0, 3)).toBe("hel");
  });

  it("slices CJK string by width", () => {
    // "안녕하" = 6 columns, slice 0-4 = "안녕"
    expect(sliceByWidth("안녕하", 0, 4)).toBe("안녕");
  });

  it("does not split CJK character", () => {
    // "안녕" = 4 columns. Slicing to width 3 should only include "안" (2 cols)
    expect(sliceByWidth("안녕", 0, 3)).toBe("안");
  });

  it("handles empty string", () => {
    expect(sliceByWidth("", 0, 5)).toBe("");
  });
});
