/**
 * Tests for Transliteration Map Module
 *
 * Validates:
 * - Korean transliteration mappings are correct
 * - expandTriggers() correctly expands trigger arrays
 * - Original triggers are preserved after expansion
 * - Deduplication works correctly
 * - Architecture is extensible (locale registry structure)
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1820
 */

import { describe, it, expect } from "vitest";
import {
  expandTriggers,
  getLocaleRegistry,
} from "../../../hooks/learner/transliteration-map.js";

describe("Transliteration Map Module", () => {
  describe("expandTriggers", () => {
    it("should expand English triggers with Korean variants", () => {
      const triggers = ["deep dive"];
      const expanded = expandTriggers(triggers);

      expect(expanded).toContain("deep dive");
      expect(expanded).toContain("딥다이브");
      expect(expanded).toContain("딥 다이브");
    });

    it("should handle multiple triggers", () => {
      const triggers = ["deep dive", "debug"];
      const expanded = expandTriggers(triggers);

      expect(expanded).toContain("deep dive");
      expect(expanded).toContain("딥다이브");
      expect(expanded).toContain("debug");
      expect(expanded).toContain("디버그");
      expect(expanded).toContain("디버깅");
    });

    it("should preserve original triggers that have no mapping", () => {
      const triggers = ["some-custom-trigger", "deploy"];
      const expanded = expandTriggers(triggers);

      expect(expanded).toContain("some-custom-trigger");
      expect(expanded).toContain("deploy");
      expect(expanded).toContain("디플로이");
    });

    it("should deduplicate variants", () => {
      // Both "deep dive" and "deep-dive" map to "딥다이브"
      const triggers = ["deep dive", "deep-dive"];
      const expanded = expandTriggers(triggers);

      const occurrences = expanded.filter((t) => t === "딥다이브");
      expect(occurrences).toHaveLength(1);
    });

    it("should return all strings in lowercase", () => {
      const triggers = ["deploy"];
      const expanded = expandTriggers(triggers);

      for (const trigger of expanded) {
        expect(trigger).toBe(trigger.toLowerCase());
      }
    });

    it("should return unchanged array when no mappings match", () => {
      const triggers = ["unmapped-trigger-xyz"];
      const expanded = expandTriggers(triggers);

      expect(expanded).toEqual(["unmapped-trigger-xyz"]);
    });

    it("should handle empty input", () => {
      const expanded = expandTriggers([]);
      expect(expanded).toEqual([]);
    });
  });

  describe("Locale Registry", () => {
    it("should have Korean (ko) locale registered", () => {
      const registry = getLocaleRegistry();
      expect(registry).toHaveProperty("ko");
    });

    it("should have non-empty Korean map", () => {
      const registry = getLocaleRegistry();
      const koEntries = Object.keys(registry.ko);
      expect(koEntries.length).toBeGreaterThan(10);
    });

    it("should have array values for all Korean entries", () => {
      const registry = getLocaleRegistry();
      for (const [key, variants] of Object.entries(registry.ko)) {
        expect(Array.isArray(variants)).toBe(true);
        expect(variants.length).toBeGreaterThan(0);
        for (const variant of variants) {
          expect(typeof variant).toBe("string");
          expect(variant.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Cross-script matching integration", () => {
    it("should enable Korean input to match English deep-dive trigger", () => {
      // Simulates the matching pipeline in bridge.ts
      const skillTriggers = ["deep dive", "deep-dive", "trace and interview", "investigate deeply"];
      const expanded = expandTriggers(skillTriggers.map((t) => t.toLowerCase()));

      const koreanInput = "해당 문제에 대해서 딥다이브 해주세요".toLowerCase();

      const matched = expanded.some((trigger) => koreanInput.includes(trigger));
      expect(matched).toBe(true);
    });

    it("should enable Korean input to match English deploy trigger", () => {
      const skillTriggers = ["deploy"];
      const expanded = expandTriggers(skillTriggers.map((t) => t.toLowerCase()));

      const koreanInput = "프로덕션에 디플로이 해주세요";

      const matched = expanded.some((trigger) => koreanInput.includes(trigger));
      expect(matched).toBe(true);
    });

    it("should still match English input after expansion", () => {
      const skillTriggers = ["deep dive"];
      const expanded = expandTriggers(skillTriggers.map((t) => t.toLowerCase()));

      const englishInput = "please do a deep dive on this issue";

      const matched = expanded.some((trigger) => englishInput.includes(trigger));
      expect(matched).toBe(true);
    });
  });
});
