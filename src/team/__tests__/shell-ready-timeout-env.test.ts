import { describe, expect, it } from "vitest";
import { resolveTeamShellReadyTimeoutMs } from "../tmux-session.js";

describe("resolveTeamShellReadyTimeoutMs", () => {
  it("keeps an explicit positive timeout", () => {
    expect(
      resolveTeamShellReadyTimeoutMs(
        { OMC_TEAM_SHELL_READY_TIMEOUT_MS: "1" },
        1_234,
      ),
    ).toBe(1_234);
  });

  it("reads a plain millisecond value", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "8000",
      }),
    ).toBe(8_000);
  });

  it("reads a scientific integer instead of stopping at the exponent", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "1e5",
      }),
    ).toBe(100_000);
  });

  it("trims whitespace around a valid timeout", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: " \t1e5\n",
      }),
    ).toBe(100_000);
  });

  it("ignores a numeric separator instead of keeping the digits before it", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "30_000",
      }),
    ).toBe(5_000);
  });

  it("ignores trailing junk instead of keeping the truncated prefix", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "12abc",
      }),
    ).toBe(5_000);
  });

  it.each(["0", "-8000", "not-a-number", "1.5", "   "])(
    "uses the default for invalid timeout %j",
    (raw) => {
      expect(
        resolveTeamShellReadyTimeoutMs({
          OMC_TEAM_SHELL_READY_TIMEOUT_MS: raw,
        }),
      ).toBe(5_000);
    },
  );

  it("rejects integers outside the safe-number range", () => {
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "9007199254740991",
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "9007199254740992",
      }),
    ).toBe(5_000);
    expect(
      resolveTeamShellReadyTimeoutMs({
        OMC_TEAM_SHELL_READY_TIMEOUT_MS: "1e309",
      }),
    ).toBe(5_000);
  });
});
