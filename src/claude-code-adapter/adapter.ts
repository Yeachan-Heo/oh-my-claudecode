import type {
  NormalizedStatusline,
  NormalizedContextWindow,
  TranscriptEvent,
  ParseResult,
  TranscriptEventType,
} from "./types.js";
import {
  StrictStatuslineSchema,
  LenientStatuslineSchema,
  StrictTranscriptEntrySchema,
  LenientTranscriptEntrySchema,
} from "./schemas.js";
import type {
  LenientStatusline,
  StrictStatusline,
  LenientTranscriptEntry,
  StrictTranscriptEntry,
} from "./schemas.js";

const UNKNOWN_EVENT: TranscriptEvent = {
  type: "unknown",
  timestamp: new Date(0),
  data: { raw: "" },
  sourceIndex: 0,
};

export class ClaudeCodeAdapter {
  parseStatusline(raw: unknown): ParseResult<NormalizedStatusline> {
    const warnings: string[] = [];
    const errors: string[] = [];

    const strictResult = StrictStatuslineSchema.safeParse(raw);
    if (strictResult.success) {
      return {
        value: this.normalizeStatusline(strictResult.data, raw),
        success: true,
        warnings,
        errors,
      };
    }

    warnings.push("Strict statusline parsing failed, using lenient defaults.");
    const lenientResult = LenientStatuslineSchema.safeParse(raw);
    if (lenientResult.success) {
      return {
        value: this.normalizeStatusline(lenientResult.data, raw),
        success: true,
        warnings,
        errors,
      };
    }

    errors.push("Failed to parse statusline payload.");
    return {
      value: ClaudeCodeAdapter.createEmpty(),
      success: false,
      warnings,
      errors,
    };
  }

  parseTranscriptLine(line: string): ParseResult<TranscriptEvent> {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!line.trim()) {
      errors.push("Empty transcript line.");
      return {
        value: this.createUnknownEvent(line, 0),
        success: false,
        warnings,
        errors,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch (error) {
      errors.push(
        `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        value: this.createUnknownEvent(line, 0),
        success: false,
        warnings,
        errors,
      };
    }

    const strictResult = StrictTranscriptEntrySchema.safeParse(payload);
    if (strictResult.success) {
      return {
        value: this.normalizeTranscriptEvent(strictResult.data, 0),
        success: true,
        warnings,
        errors,
      };
    }

    warnings.push(
      "Strict transcript entry parsing failed, using lenient defaults.",
    );
    const lenientResult = LenientTranscriptEntrySchema.safeParse(payload);
    if (!lenientResult.success) {
      errors.push("Failed to parse transcript entry payload.");
      return {
        value: this.createUnknownEvent(line, 0),
        success: false,
        warnings,
        errors,
      };
    }

    return {
      value: this.normalizeTranscriptEvent(lenientResult.data, 0),
      success: true,
      warnings,
      errors,
    };
  }

  parseTranscript(content: string): ParseResult<TranscriptEvent[]> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const events: TranscriptEvent[] = [];
    let parsedCount = 0;
    let failedCount = 0;

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) {
        return;
      }

      const result = this.parseTranscriptLine(line);
      const value = { ...result.value, sourceIndex: index };
      events.push(value);

      if (result.success) {
        parsedCount += 1;
      } else {
        failedCount += 1;
        errors.push(...result.errors);
      }

      warnings.push(...result.warnings);
    });

    if (parsedCount === 0 && failedCount > 0) {
      errors.push("Unable to parse any transcript entries.");
      return {
        value: events,
        success: false,
        warnings,
        errors,
      };
    }

    if (failedCount > parsedCount) {
      if (parsedCount > 0) {
        warnings.push(
          `Partial parse: ${failedCount} of ${failedCount + parsedCount} entries failed (>50% error rate)`,
        );
      }
      return {
        value: events,
        success: false,
        warnings,
        errors,
      };
    }

    return {
      value: events,
      success: true,
      warnings,
      errors,
    };
  }

  static createEmpty(): NormalizedStatusline {
    return {
      transcriptPath: "",
      cwd: process.cwd(),
      model: {
        id: "unknown",
        displayName: "Unknown Model",
      },
      contextWindow: {
        size: 200000,
        usedPercent: 0,
        tokens: {
          input: 0,
          cacheCreation: 0,
          cacheRead: 0,
          total: 0,
        },
      },
    };
  }

  private normalizeStatusline(
    data: StrictStatusline | LenientStatusline,
    raw: unknown,
  ): NormalizedStatusline {
    const usage = data.context_window.current_usage ?? {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    const totalTokens =
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens;
    const usedPercent =
      data.context_window.used_percentage ??
      (data.context_window.context_window_size > 0
        ? (totalTokens / data.context_window.context_window_size) * 100
        : 0);

    const contextWindow: NormalizedContextWindow = {
      size: data.context_window.context_window_size,
      usedPercent,
      tokens: {
        input: usage.input_tokens,
        cacheCreation: usage.cache_creation_input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        total: totalTokens,
      },
    };

    return {
      transcriptPath: data.transcript_path,
      cwd: data.cwd,
      model: {
        id: data.model.id,
        displayName: data.model.display_name,
      },
      contextWindow,
      _raw: raw,
    };
  }

  private normalizeTranscriptEvent(
    entry: StrictTranscriptEntry | LenientTranscriptEntry,
    sourceIndex: number,
  ): TranscriptEvent {
    const type = this.detectTranscriptEventType(entry);
    const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();

    return {
      type,
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
      data: { entry },
      sourceIndex,
    };
  }

  private detectTranscriptEventType(
    entry: StrictTranscriptEntry | LenientTranscriptEntry,
  ): TranscriptEventType {
    const type = entry.type?.toLowerCase() ?? "";
    const role = entry.message?.role?.toLowerCase() ?? "";
    const content = entry.message?.content ?? [];

    if (type.includes("agent_start")) {
      return "agent_start";
    }
    if (type.includes("agent_end")) {
      return "agent_end";
    }
    if (type.includes("error")) {
      return "error";
    }
    if (type.includes("thinking") || type.includes("reasoning")) {
      return "thinking";
    }
    if (role === "user") {
      return "user_message";
    }
    if (role === "assistant") {
      return "assistant_message";
    }
    if (content.some((block) => block.type === "tool_use")) {
      return "tool_use";
    }
    if (content.some((block) => block.type === "tool_result")) {
      return "tool_result";
    }
    if (
      content.some(
        (block) => block.type === "thinking" || block.type === "reasoning",
      )
    ) {
      return "thinking";
    }

    return "unknown";
  }

  private createUnknownEvent(
    line: string,
    sourceIndex: number,
  ): TranscriptEvent {
    if (!line) {
      return { ...UNKNOWN_EVENT, sourceIndex };
    }

    return {
      type: "unknown",
      timestamp: new Date(),
      data: { raw: line },
      sourceIndex,
    };
  }
}
