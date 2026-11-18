/**
 * The whole path from sendReplyInjectionSteps to the daemon log on native Windows when `where tmux` resolves a `.cmd`
 * wrapper (psmux): the real tmuxExec and resolveTmuxInvocation build the command line, with quoteForCmd around every
 * argument, and only the process is replaced (execFileSync fails the way Node reports a failed command:
 * `Command failed: <file> <arguments joined by spaces>`).
 */

import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The log path is fixed when reply-listener.ts is loaded, so the state directory must be set before that.
const stateHome = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "omc-reply-cmd-wrapper-"));
  process.env.OMC_HOME = dir;
  return dir;
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});

import { execFileSync, spawnSync } from "child_process";
import {
  buildReplyInjectionSteps,
  sendReplyInjectionSteps,
  type ReplyListenerDaemonConfig,
} from "../reply-listener.js";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

const SWITCH = "OMC_REDACT_KEY_SHAPES";
const LOG_FILE = join(stateHome, "state", "reply-listener.log");
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";
const config = { includePrefix: false, maxMessageLength: 500 } as unknown as ReplyListenerDaemonConfig;
const REPLY = 'PASSWORD="start\\"sensitive-suffix"';

/** Fails send-keys on native Windows with a `.cmd` tmux; returns what was logged. */
function failOnWindows(reply: string): string {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    vi.stubEnv("COMSPEC", COMSPEC);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "C:\\Program Files\\psmux\\tmux.cmd\r\n",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExecFileSync.mockImplementation(((file: string, args: readonly string[]) => {
      throw new Error(`Command failed: ${[file, ...args].join(" ")}`);
    }) as unknown as typeof execFileSync);
    expect(sendReplyInjectionSteps("%5", buildReplyInjectionSteps(reply, "discord", config))).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
  const text = readFileSync(LOG_FILE, "utf-8");
  return text.slice(text.lastIndexOf("ERROR: Failed to send reply injection steps")).trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(LOG_FILE, { force: true });
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
  delete process.env.OMC_HOME;
});

describe("a failed send-keys through a tmux that is a .cmd wrapper on native Windows", () => {
  const COMMAND_LINE = (typed: string): string => `"C:\\Program Files\\psmux\\tmux.cmd" send-keys -t "%%5" -l ${typed}`;

  it("switch on: the quotes that quoteForCmd doubled do not end the value, the suffix is not logged", () => {
    vi.stubEnv(SWITCH, "1");
    const logged = failOnWindows(REPLY);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      COMSPEC,
      ["/d", "/s", "/c", COMMAND_LINE('"PASSWORD=""start\\\\""sensitive-suffix"""')],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(logged).toBe(
      `ERROR: Failed to send reply injection steps to pane %5: Command failed: ${COMSPEC} /d /s /c ${COMMAND_LINE('"PASSWORD=""****"""')}`,
    );
  });

  it.each([undefined, "", "0", "true"])("switch off (%s): the message is logged as the error carries it", (value) => {
    vi.stubEnv(SWITCH, value);
    expect(failOnWindows(REPLY)).toBe(
      `ERROR: Failed to send reply injection steps to pane %5: Command failed: ${COMSPEC} /d /s /c ${COMMAND_LINE('"PASSWORD=""start\\\\""sensitive-suffix"""')}`,
    );
  });
});
