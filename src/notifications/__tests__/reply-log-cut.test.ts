/**
 * The reply that a failed command typed into a pane stands in the message of its error, cut at maxMessageLength.
 * A key that runs over the cut is only a fragment there, too short to be recognized, so the log must show the
 * reply redacted as a whole and cut afterwards, on every path that logs such a message (tmux send-keys, a .cmd
 * wrapper around tmux, the command line and the stderr of a failed Herdr prompt).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The log path is fixed when reply-listener.ts is loaded, so the state directory must be set before that.
const stateHome = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "omc-reply-cut-"));
  process.env.OMC_HOME = dir;
  return dir;
});

const mocks = vi.hoisted(() => ({
  captureHerdrWorkerPane: vi.fn(),
  herdrSendPrompt: vi.fn(),
  isHerdrWorkerAlive: vi.fn(),
  tmuxExec: vi.fn(),
}));

vi.mock("../../cli/tmux-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/tmux-utils.js")>();
  return { ...actual, tmuxExec: mocks.tmuxExec };
});

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    captureHerdrWorkerPane: mocks.captureHerdrWorkerPane,
    herdrSendPrompt: mocks.herdrSendPrompt,
    isHerdrWorkerAlive: mocks.isHerdrWorkerAlive,
  };
});

import { quoteForCmd } from "../../cli/tmux-utils.js";
import { HerdrError } from "../../team/herdr-session.js";
import {
  buildReplyInjectionSteps,
  injectReplyIntoHerdrPane,
  sendReplyInjectionSteps,
  type ReplyListenerDaemonConfig,
} from "../reply-listener.js";
import { redactTokens } from "../redact.js";

const SWITCH = "OMC_REDACT_KEY_SHAPES";
const LOG_FILE = join(stateHome, "state", "reply-listener.log");
const PREFIX = "[reply:discord] ";

const configWith = (maxMessageLength: number, includePrefix = false) =>
  ({ includePrefix, maxMessageLength }) as unknown as ReplyListenerDaemonConfig;

// [name, head that stays visible, characters the shape needs after the head, characters after the head in the
// reply, the masked head]. The secret is made of Q and Z, which stand nowhere else in the log line.
const KINDS: Array<[name: string, head: string, needs: number, length: number, masked: string]> = [
  ["hf_", "hf_", 20, 30, "hf_****"],
  ["xai-", "xai-", 20, 30, "xai-****"],
  ["gsk_", "gsk_", 20, 30, "gsk_****"],
  ["AIza", "AIza", 20, 30, "AIza****"],
  ["sk-", "sk-", 8, 20, "sk-****"],
  ["sk_live_", "sk_live_", 16, 26, "sk_live_****"],
  ["rk_", "rk_", 16, 26, "rk_****"],
  ["AKIA (exactly 16 after the head)", "AKIA", 16, 16, "AKIA****"],
  ["Telegram bot token", "123456789:", 20, 30, "123456789:****"],
  ["an assignment", "PASSWORD=", 1, 12, "PASSWORD=****"],
  ["a JWT (segments of at least 8 characters)", "eyJ", 26, 48, "eyJ***"],
];
const secret = (head: string, length: number): string =>
  (head === "eyJ" ? `QZQZQZQZ.QZQZQZQZ.${"QZ".repeat(30)}` : "QZ".repeat(length)).slice(0, length);

/**
 * A reply in which `inside` characters of the secret lie inside the first `max` characters of the typed text
 * (the reply prefix counts), with the text that the log must show: the reply redacted as a whole, then cut.
 */
const replyWith = (
  [, head, , length, masked]: (typeof KINDS)[number],
  max: number,
  inside: number,
  includePrefix: boolean,
): { reply: string; typed: string; shown: string } | undefined => {
  const prefix = includePrefix ? PREFIX : "";
  const fillerLength = max - prefix.length - head.length - inside - 1;
  if (fillerLength < 1) return undefined; // the filler is not blank: sanitizeReplyInput trims
  const filler = `${"x".repeat(fillerLength)} `;
  const reply = `${filler}${head}${secret(head, length)}`;
  // The log line is redacted once more as a whole, which makes the part of **** that the cut leaves after an
  // assignment (`PASSWORD=*`) a value of its own: it becomes ****.
  const shown = `${prefix}${filler}${masked}`.slice(0, max).replace(/(PASSWORD=)\*+$/, "$1****");
  return { reply, typed: `${prefix}${reply}`.slice(0, max), shown };
};

/** The cases of the grid: every kind x how much of the secret is typed x maxMessageLength x reply prefix. */
const grid = (): Array<{ label: string; reply: string; typed: string; shown: string; max: number; includePrefix: boolean }> => {
  const cases = [];
  for (const kind of KINDS) {
    const [name, , needs, length] = kind;
    for (const inside of new Set([0, 1, needs - 1, needs, needs + 4].map((n) => Math.min(n, length)))) {
      for (const max of [30, 60, 500]) {
        for (const includePrefix of [false, true]) {
          const made = replyWith(kind, max, inside, includePrefix);
          if (made) cases.push({ ...made, label: `${name}, ${inside} typed, max ${max}, prefix ${includePrefix}`, max, includePrefix });
        }
      }
    }
  }
  return cases;
};

const lastLine = (needle: string): string => {
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
  return (lines.filter((l) => l.includes(needle)).pop() ?? "").replace(/^\[[^\]]*\] /, "");
};

const WRAPPER = "C:\\Program Files\\psmux\\tmux.cmd";
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";
const LAYERS: Array<[name: string, message: (args: string[]) => string]> = [
  ["tmux started directly", (args) => `Command failed: tmux -u ${args.join(" ")}`],
  [
    "a .cmd wrapper on native Windows (quoteForCmd)",
    (args) => `Command failed: ${COMSPEC} /d /s /c ${[WRAPPER, ...args].map(quoteForCmd).join(" ")}`,
  ],
];

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[SWITCH];
  vi.clearAllMocks();
  rmSync(LOG_FILE, { force: true });
  mocks.captureHerdrWorkerPane.mockResolvedValue("Claude Code session output");
  mocks.herdrSendPrompt.mockResolvedValue(undefined);
  mocks.tmuxExec.mockReset();
  mocks.tmuxExec.mockReturnValue("");
});

afterEach(() => {
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
  delete process.env.OMC_HOME;
});

describe("a failed command that typed a cut reply: the log shows the reply redacted as a whole, then cut", () => {
  const sendFailure = (
    message: (args: string[]) => string,
    reply: string,
    max: number,
    includePrefix: boolean,
    mapping?: Parameters<typeof buildReplyInjectionSteps>[3],
  ): { logged: string; typedInPane: string } => {
    const steps = buildReplyInjectionSteps(reply, "discord", configWith(max, includePrefix), mapping);
    let typedInPane = "";
    mocks.tmuxExec.mockImplementation((args: string[]) => {
      if (!args.includes("-l")) return "";
      typedInPane = args[args.length - 1];
      throw new Error(message(args));
    });
    expect(sendReplyInjectionSteps("%5", steps)).toBe(false);
    return { logged: lastLine("Failed to send reply injection steps"), typedInPane };
  };
  const expectedLine = (message: (args: string[]) => string, shown: string): string =>
    `ERROR: Failed to send reply injection steps to pane %5: ${message(["send-keys", "-t", "%5", "-l", shown])}`;

  describe("switch on", () => {
    beforeEach(() => {
      process.env[SWITCH] = "1";
    });

    it("the grid is not empty", () => {
      expect(grid().length).toBeGreaterThan(150);
    });

    it.each(LAYERS)("tmux send-keys, %s: every kind x how much of the secret is typed x length limit", (_name, message) => {
      for (const { label, reply, typed, shown, max, includePrefix } of grid()) {
        const { logged, typedInPane } = sendFailure(message, reply, max, includePrefix);
        expect(typedInPane, `${label}: what is typed is not touched`).toBe(typed);
        expect(logged, label).toBe(expectedLine(message, shown));
        expect(logged, `${label}: no character of the secret`).not.toMatch(/[QZ]/);
      }
    });

    it("tmux send-keys, the steps of an ask-user-question reply (the reply is typed after the menu keys)", () => {
      const mapping = { event: "ask-user-question" as const, askUserQuestionOptionCount: 2, askUserQuestionAllowOther: true };
      for (const { label, reply, shown, max, includePrefix } of grid()) {
        const { logged } = sendFailure(LAYERS[0][1], reply, max, includePrefix, mapping);
        expect(logged, label).toBe(expectedLine(LAYERS[0][1], shown));
      }
    });

    it("the Herdr path, the command line of the failed process: the whole reply is redacted, then cut", async () => {
      for (const { label, reply, typed, shown, max, includePrefix } of grid()) {
        mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("spawn_failed", `Command failed: herdr agent prompt w9:p2 ${typed}`));
        await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(max, includePrefix));
        expect(lastLine("Failed to inject reply into herdr pane"), label).toBe(
          `ERROR: Failed to inject reply into herdr pane w9:p2: herdr_spawn_failed: Command failed: herdr agent prompt w9:p2 ${shown}`,
        );
        expect(mocks.herdrSendPrompt).toHaveBeenLastCalledWith("w9:p2", typed); // what is typed is not touched
      }
    });

    it("the Herdr path, stderr that echoes the typed reply (the message holds its first 300 characters)", async () => {
      for (const { label, reply, typed, shown, max, includePrefix } of grid()) {
        const stderr = `cannot type: ${typed}\n`;
        mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("error", stderr.trim().slice(0, 300), stderr));
        await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(max, includePrefix));
        expect(lastLine("Failed to inject reply into herdr pane"), label).toBe(
          `ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: ${`cannot type: ${shown}`.slice(0, 300)}`,
        );
      }
    });

    it("the example from review: 477 characters, then hf_ and 30 more, with the default limit of 500", async () => {
      const reply = `${"a".repeat(477)} hf_${"x".repeat(30)}`;
      const { logged } = sendFailure(LAYERS[0][1], reply, 500, false);
      expect(logged).toBe(expectedLine(LAYERS[0][1], `${"a".repeat(477)} hf_****`));
      mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("spawn_failed", `Command failed: herdr agent prompt w9:p2 ${reply.slice(0, 500)}`));
      await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(500));
      expect(readFileSync(LOG_FILE, "utf-8")).not.toContain("hf_x");
    });

    it("a reply that holds no secret is logged as it was typed", () => {
      for (const max of [10, 60, 500]) {
        const reply = "please-run-the-tests-again-and-report-back-thanks".repeat(20);
        const { logged, typedInPane } = sendFailure(LAYERS[0][1], reply, max, true);
        expect(logged).toBe(expectedLine(LAYERS[0][1], typedInPane));
      }
    });

    it("steps built by hand have no whole reply: the typed text is redacted as it stands", () => {
      mocks.tmuxExec.mockImplementation((args: string[]) => {
        throw new Error(`Command failed: tmux ${args.join(" ")}`);
      });
      expect(sendReplyInjectionSteps("%5", [{ kind: "literal", value: "PASSWORD=canary" }])).toBe(false);
      expect(lastLine("Failed to send reply injection steps")).toBe(
        "ERROR: Failed to send reply injection steps to pane %5: Command failed: tmux send-keys -t %5 -l PASSWORD=****",
      );
    });
  });

  it.each([undefined, "", "0", "true"])("switch off (%s): the message is logged as the error carries it", async (value) => {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
    for (const { label, reply, typed, max, includePrefix } of grid()) {
      const { logged } = sendFailure(LAYERS[0][1], reply, max, includePrefix);
      // the message as the error carries it, with what the log line has always done to it: the regex rules
      expect(logged, label).toBe(redactTokens(expectedLine(LAYERS[0][1], typed)));
      mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("spawn_failed", `Command failed: herdr agent prompt w9:p2 ${typed}`));
      await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(max, includePrefix));
      expect(lastLine("Failed to inject reply into herdr pane"), label).toBe(
        redactTokens(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_spawn_failed: Command failed: herdr agent prompt w9:p2 ${typed}`),
      );
    }
  });
});
