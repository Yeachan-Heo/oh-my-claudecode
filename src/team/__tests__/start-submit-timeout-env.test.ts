import { describe, expect, it } from "vitest";
import * as tmuxSession from "../tmux-session.js";

const resolve = (raw: string | undefined, explicit?: number): number =>
  tmuxSession.resolveTeamStartSubmitTimeoutMs(
    { OMC_TEAM_START_SUBMIT_TIMEOUT_MS: raw },
    explicit,
  );

describe("resolveTeamStartSubmitTimeoutMs", () => {
  it("keeps an explicit positive timeout", () => {
    expect(resolve("1", 1_234)).toBe(1_234);
  });

  it("uses the 8s default when unset", () => {
    expect(resolve(undefined)).toBe(8_000);
  });

  it("reads a plain millisecond value", () => {
    expect(resolve("12000")).toBe(12_000);
  });

  it("reads a scientific integer instead of stopping at the exponent", () => {
    expect(resolve("1e5")).toBe(100_000);
    expect(resolve(" 2.5e4\n")).toBe(25_000);
  });

  it.each(["30_000", "12abc", "0", "-8000", "1.5", "   ", "1e309"])(
    "uses the default for %j instead of a truncated prefix",
    (raw) => {
      expect(resolve(raw)).toBe(8_000);
    },
  );
});
