import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "../claude-code-adapter/adapter.js";

const validTranscriptLine = JSON.stringify({
  type: "assistant",
  timestamp: "2025-01-01T00:00:00Z",
  sessionId: "s1",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
  },
});

const lenientTranscriptLine = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [] },
});

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  describe("parseStatusline", () => {
    it("parses strict payloads", () => {
      const result = adapter.parseStatusline({
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp",
        model: { id: "model-1", display_name: "Model 1" },
        context_window: { context_window_size: 100000 },
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.value.transcriptPath).toBe("/tmp/transcript.jsonl");
      expect(result.value.model.id).toBe("model-1");
    });

    it("falls back to lenient defaults", () => {
      const result = adapter.parseStatusline({});

      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        "Strict statusline parsing failed, using lenient defaults.",
      );
      expect(result.value.model.id).toBe("unknown");
    });

    it("fails for invalid payloads", () => {
      const result = adapter.parseStatusline("nope");

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Failed to parse statusline payload.");
    });
  });

  describe("parseTranscriptLine", () => {
    it("parses valid transcript JSON lines", () => {
      const result = adapter.parseTranscriptLine(validTranscriptLine);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.value.type).toBe("assistant_message");
    });

    it("returns error for empty lines", () => {
      const result = adapter.parseTranscriptLine("   ");

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Empty transcript line.");
    });

    it("returns error for invalid JSON", () => {
      const result = adapter.parseTranscriptLine("{not-json");

      expect(result.success).toBe(false);
      expect(
        result.errors.some((error) => error.startsWith("Invalid JSON:")),
      ).toBe(true);
    });

    it("keeps strict parsing when valid", () => {
      const result = adapter.parseTranscriptLine(validTranscriptLine);

      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("falls back to lenient parsing when needed", () => {
      const result = adapter.parseTranscriptLine(lenientTranscriptLine);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        "Strict transcript entry parsing failed, using lenient defaults.",
      );
      expect(result.value.type).toBe("assistant_message");
    });
  });

  describe("parseTranscript", () => {
    it("returns empty events for empty content", () => {
      const result = adapter.parseTranscript("");

      expect(result.success).toBe(true);
      expect(result.value).toHaveLength(0);
    });

    it("parses all valid lines", () => {
      const content = [validTranscriptLine, validTranscriptLine].join("\n");
      const result = adapter.parseTranscript(content);

      expect(result.success).toBe(true);
      expect(result.value).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when all lines are invalid", () => {
      const content = ["{bad-json", "{bad-json-too}"].join("\n");
      const result = adapter.parseTranscript(content);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Unable to parse any transcript entries.",
      );
      expect(
        result.errors.some((error) => error.startsWith("Invalid JSON:")),
      ).toBe(true);
    });

    it("fails when failures exceed successes", () => {
      const content = [
        validTranscriptLine,
        "{bad-json",
        "{bad-json-two",
        "{bad-json-three",
      ].join("\n");
      const result = adapter.parseTranscript(content);

      expect(result.success).toBe(false);
      expect(result.warnings).toContain(
        "Partial parse: 3 of 4 entries failed (>50% error rate)",
      );
      expect(
        result.errors.some((error) => error.startsWith("Invalid JSON:")),
      ).toBe(true);
      expect(result.value).toHaveLength(4);
    });

    it("succeeds when most lines parse and warns on lenient fallback", () => {
      const content = [
        validTranscriptLine,
        validTranscriptLine,
        validTranscriptLine,
        lenientTranscriptLine,
      ].join("\n");
      const result = adapter.parseTranscript(content);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        "Strict transcript entry parsing failed, using lenient defaults.",
      );
    });

    it("skips whitespace-only lines", () => {
      const result = adapter.parseTranscript(" \n\n\t");

      expect(result.success).toBe(true);
      expect(result.value).toHaveLength(0);
    });
  });

  describe("createEmpty", () => {
    it("returns a valid empty statusline", () => {
      const result = ClaudeCodeAdapter.createEmpty();

      expect(result.transcriptPath).toBe("");
      expect(result.model.id).toBe("unknown");
      expect(result.model.displayName).toBe("Unknown Model");
      expect(result.contextWindow.size).toBe(200000);
      expect(result.contextWindow.usedPercent).toBe(0);
    });
  });
});
