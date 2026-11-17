/**
 * The daemon log shows the first 50 characters of an injected reply. The reply must be redacted before it is
 * cut, on both injection paths (Herdr and tmux), also when maxMessageLength cuts the reply first.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The log path is fixed when reply-listener.ts is loaded, so the state directory must be set before that.
const stateHome = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "omc-reply-preview-"));
  process.env.OMC_HOME = dir;
  return dir;
});

const mocks = vi.hoisted(() => ({
  captureHerdrWorkerPane: vi.fn(),
  herdrSendPrompt: vi.fn(),
  isHerdrWorkerAlive: vi.fn(),
  capturePaneContent: vi.fn(),
  sendToPane: vi.fn(),
  removeMessagesByPane: vi.fn(),
}));

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    captureHerdrWorkerPane: mocks.captureHerdrWorkerPane,
    herdrSendPrompt: mocks.herdrSendPrompt,
    isHerdrWorkerAlive: mocks.isHerdrWorkerAlive,
  };
});

vi.mock("../../features/rate-limit-wait/tmux-detector.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../features/rate-limit-wait/tmux-detector.js")>();
  return {
    ...actual,
    capturePaneContent: mocks.capturePaneContent,
    sendToPane: mocks.sendToPane,
  };
});

vi.mock("../session-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../session-registry.js")>();
  return { ...actual, removeMessagesByPane: mocks.removeMessagesByPane };
});

import { HerdrError, runHerdr, type HerdrExecOptions } from "../../team/herdr-session.js";
import {
  injectReplyIntoHerdrPane,
  processSlackSocketMessage,
  replyLogPreview,
  sanitizeReplyInput,
  SlackConnectionStateTracker,
  RateLimiter,
  type ReplyListenerDaemonConfig,
  type ReplyListenerState,
} from "../reply-listener.js";

const SWITCH = "OMC_REDACT_KEY_SHAPES";
const LOG_FILE = join(stateHome, "state", "reply-listener.log");

const configWith = (maxMessageLength: number, includePrefix = false) =>
  ({ includePrefix, maxMessageLength }) as unknown as ReplyListenerDaemonConfig;

// Keys that start so that exactly one character less than the minimum length of their shape lies inside the
// first 50 characters of the reply, and a JWT whose signature is cut to 7 characters.
const KEYS: Array<[name: string, key: string, minSuffix: number, masked: string]> = [
  ["hf_", "hf_", 20, "hf_****"],
  ["xai-", "xai-", 20, "xai-****"],
  ["gsk_", "gsk_", 20, "gsk_****"],
  ["AIza", "AIza", 20, "AIza****"],
  ["sk-", "sk-", 8, "sk-****"],
];
const replyWithKeyAtTheCut = (key: string, minSuffix: number): { text: string; filler: string } => {
  const filler = "x".repeat(50 - key.length - (minSuffix - 1) - 1) + " ";
  return { text: `${filler}${key}${"a".repeat(minSuffix + 30)}`, filler };
};
const jwtAtTheCut = (): { text: string; filler: string } => {
  const filler = "x".repeat(21) + " ";
  return { text: `${filler}eyJ${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(40)}`, filler };
};

/** The part of the last "Injected reply" log line that follows the pane id, without the timestamp. */
const loggedPreview = (): string => {
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
  const line = lines.filter((l) => l.includes("Injected reply from")).pop() ?? "";
  const match = line.match(/: "(.*)"$/);
  expect(match, `no preview in: ${line}`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
};

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[SWITCH];
  vi.clearAllMocks();
  rmSync(LOG_FILE, { force: true });
  mocks.captureHerdrWorkerPane.mockResolvedValue("Claude Code session output");
  mocks.herdrSendPrompt.mockResolvedValue(undefined);
  mocks.capturePaneContent.mockReturnValue("Claude Code session output");
  mocks.sendToPane.mockReturnValue(true);
});

afterEach(() => {
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
  delete process.env.OMC_HOME;
});

describe("replyLogPreview, switch on", () => {
  beforeEach(() => {
    process.env[SWITCH] = "1";
  });

  it.each(KEYS)("%s key that starts just before the 50-character cut: masked", (_name, key, minSuffix, masked) => {
    const { text, filler } = replyWithKeyAtTheCut(key, minSuffix);
    expect(replyLogPreview(text, "slack", configWith(500))).toBe(`${filler}${masked}`);
  });

  it("a JWT whose signature is cut to 7 characters: masked", () => {
    const { text, filler } = jwtAtTheCut();
    expect(replyLogPreview(text, "slack", configWith(500))).toBe(`${filler}eyJ***`);
  });

  it("the reply prefix counts toward the cut", () => {
    // "[reply:slack] " is 14 characters, so the key must start 14 characters earlier
    const filler = "x".repeat(50 - 14 - "hf_".length - 19 - 1) + " ";
    const text = `${filler}hf_${"a".repeat(50)}`;
    expect(replyLogPreview(text, "slack", configWith(500, true))).toBe(`[reply:slack] ${filler}hf_****`);
  });

  it("maxMessageLength below 50 cuts the injected reply, but the log still masks the key", () => {
    const text = `${"x".repeat(24)} hf_${"a".repeat(40)}`;
    // the injected text is the first 40 characters: 12 characters of the key, too few to be recognized
    expect(sanitizeReplyInput(text).slice(0, 40)).toBe(`${"x".repeat(24)} hf_${"a".repeat(12)}`);
    expect(replyLogPreview(text, "slack", configWith(40))).toBe(`${"x".repeat(24)} hf_****`);
  });
});

describe("replyLogPreview, switch off: the preview is cut first and the output does not change", () => {
  it.each([undefined, "", "0", "true"])("with value %s", (value) => {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
    const legacy = (text: string, platform: string, config: ReplyListenerDaemonConfig): string => {
      const preview = sanitizeReplyInput((config.includePrefix ? `[reply:${platform}] ` : "") + text).slice(
        0,
        config.maxMessageLength,
      );
      return `${preview.slice(0, 50)}${preview.length > 50 ? "..." : ""}`;
    };
    const texts = [
      "hello",
      "y".repeat(50),
      "y".repeat(51),
      `${"x".repeat(30)} xoxb-${"1".repeat(40)} tail`,
      `${"x".repeat(30)} 123456789:${"A".repeat(40)}`,
      `${"x".repeat(28)} hf_${"a".repeat(40)}`,
      `echo \`whoami\` $(id) ${"z".repeat(60)}`,
      `line one\nline two ${"q".repeat(60)}`,
    ];
    for (const text of texts) {
      for (const max of [10, 40, 50, 51, 500]) {
        for (const includePrefix of [false, true]) {
          const config = configWith(max, includePrefix);
          expect(replyLogPreview(text, "slack", config)).toBe(legacy(text, "slack", config));
        }
      }
    }
  });
});

describe("injection paths write the masked preview to the log", () => {
  beforeEach(() => {
    process.env[SWITCH] = "1";
  });

  it.each(KEYS)("Herdr path, %s key at the cut", async (_name, key, minSuffix, masked) => {
    const { text, filler } = replyWithKeyAtTheCut(key, minSuffix);
    await expect(injectReplyIntoHerdrPane("w9:p2", text, "discord", configWith(500))).resolves.toBe(true);
    expect(mocks.herdrSendPrompt).toHaveBeenCalledWith("w9:p2", text); // what is typed is not touched
    expect(loggedPreview()).toBe(`${filler}${masked}`);
  });

  it("Herdr path, JWT at the cut", async () => {
    const { text, filler } = jwtAtTheCut();
    await injectReplyIntoHerdrPane("w9:p2", text, "discord", configWith(500));
    expect(loggedPreview()).toBe(`${filler}eyJ***`);
  });

  it("Herdr path, maxMessageLength below 50", async () => {
    const text = `${"x".repeat(24)} hf_${"a".repeat(40)}`;
    await injectReplyIntoHerdrPane("w9:p2", text, "discord", configWith(40));
    expect(mocks.herdrSendPrompt).toHaveBeenCalledWith("w9:p2", `${"x".repeat(24)} hf_${"a".repeat(12)}`);
    expect(loggedPreview()).toBe(`${"x".repeat(24)} hf_****`);
  });

  const slackMessage = (text: string): string =>
    JSON.stringify({ type: "events_api", envelope_id: "E1", payload: { event: { type: "message", text } } });
  const processSlack = async (text: string, config: ReplyListenerDaemonConfig): Promise<boolean> => {
    const connection = new SlackConnectionStateTracker();
    connection.onAuthenticated();
    const state = { errors: 0, messagesInjected: 0 } as unknown as ReplyListenerState;
    const result = await processSlackSocketMessage(slackMessage(text), connection, "%5", config, state, new RateLimiter(10));
    return result.injected;
  };

  it.each(KEYS)("tmux path, %s key at the cut", async (_name, key, minSuffix, masked) => {
    const { text, filler } = replyWithKeyAtTheCut(key, minSuffix);
    await expect(processSlack(text, configWith(500))).resolves.toBe(true);
    expect(mocks.sendToPane).toHaveBeenCalledWith("%5", text, true);
    expect(loggedPreview()).toBe(`${filler}${masked}`);
  });

  it("tmux path, JWT at the cut", async () => {
    const { text, filler } = jwtAtTheCut();
    await processSlack(text, configWith(500));
    expect(loggedPreview()).toBe(`${filler}eyJ***`);
  });

  it("tmux path, maxMessageLength below 50", async () => {
    const text = `${"x".repeat(24)} hf_${"a".repeat(40)}`;
    await processSlack(text, configWith(40));
    expect(mocks.sendToPane).toHaveBeenCalledWith("%5", `${"x".repeat(24)} hf_${"a".repeat(12)}`, true);
    expect(loggedPreview()).toBe(`${"x".repeat(24)} hf_****`);
  });

  it("with the switch off the log line is the same as before (the fragment of the key is logged)", async () => {
    delete process.env[SWITCH];
    const { text, filler } = replyWithKeyAtTheCut("hf_", 20);
    await injectReplyIntoHerdrPane("w9:p2", text, "discord", configWith(500));
    expect(loggedPreview()).toBe(`${filler}hf_${"a".repeat(19)}...`);
    expect(existsSync(LOG_FILE)).toBe(true);
  });
});

// A failed Herdr command puts the first 300 characters of its plain-text stderr into the error message and keeps
// all of it in `detail`. The log must mask a key that starts shortly before character 300.
describe("errors from the Herdr CLI in the log", () => {
  const stderrWithKeyAtTheCut = (): { stderr: string; filler: string } => {
    // 278 characters, then hf_ and 19 characters of the key: character 300 falls inside the key
    const filler = "x".repeat(277) + " ";
    return { stderr: `${filler}hf_${"a".repeat(40)}\n`, filler };
  };
  const failingHerdr = (stderr: string): Promise<HerdrError> =>
    runHerdr(["agent", "prompt", "w9:p2"], {
      env: {},
      execFn: (() => Promise.reject(Object.assign(new Error("exit 1"), { stderr }))) as unknown as HerdrExecOptions["execFn"],
    }).then(
      () => {
        throw new Error("runHerdr did not fail");
      },
      (error: HerdrError) => error,
    );
  const loggedLine = (needle: string): string => {
    const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    return (lines.filter((l) => l.includes(needle)).pop() ?? "").replace(/^\[[^\]]*\] /, "");
  };

  it("runHerdr keeps the whole stderr in detail and the first 300 characters in the message", async () => {
    const { stderr, filler } = stderrWithKeyAtTheCut();
    const error = await failingHerdr(stderr);
    expect(error).toBeInstanceOf(HerdrError);
    expect(error.detail).toBe(stderr);
    expect(error.message).toBe(`herdr_error: ${filler}hf_${"a".repeat(19)}`);
  });

  describe("switch on", () => {
    beforeEach(() => {
      process.env[SWITCH] = "1";
    });

    it("send failure: the key at character 300 is masked", async () => {
      const { stderr, filler } = stderrWithKeyAtTheCut();
      mocks.herdrSendPrompt.mockRejectedValue(await failingHerdr(stderr));
      await expect(injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500))).resolves.toBe(false);
      expect(loggedLine("Failed to inject")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: ${filler}hf_****`);
    });

    it("capture failure: the key at character 300 is masked", async () => {
      const { stderr, filler } = stderrWithKeyAtTheCut();
      mocks.captureHerdrWorkerPane.mockRejectedValue(await failingHerdr(stderr));
      mocks.isHerdrWorkerAlive.mockResolvedValue(true);
      await expect(injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500))).resolves.toBe(false);
      expect(loggedLine("Failed to capture")).toBe(`WARN: Failed to capture herdr pane w9:p2: herdr_error: ${filler}hf_****`);
    });

    it("other errors keep their own message: a JSON error envelope, another error class, a value that is not an error", async () => {
      const cases: Array<[unknown, string]> = [
        [new HerdrError("agent_name_taken", "taken", '{"error":{"code":"agent_name_taken","message":"taken"}}'), "herdr_agent_name_taken: taken"],
        [new HerdrError("error", "short", "not the cut of this stderr"), "herdr_error: short"],
        [new Error("boom"), "boom"],
        ["plain failure", "plain failure"],
      ];
      for (const [error, text] of cases) {
        mocks.herdrSendPrompt.mockRejectedValue(error);
        await injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500));
        expect(loggedLine("Failed to inject")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: ${text}`);
      }
    });
  });

  it.each([undefined, "", "0", "true"])("switch off (%s): the message is cut first, as the error carries it", async (value) => {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
    const { stderr, filler } = stderrWithKeyAtTheCut();
    mocks.herdrSendPrompt.mockRejectedValue(await failingHerdr(stderr));
    await injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500));
    expect(loggedLine("Failed to inject")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: ${filler}hf_${"a".repeat(19)}`);
  });
});
