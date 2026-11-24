/**
 * The daemon log shows the first 50 characters of an injected reply. The reply must be redacted before it is
 * cut, on both injection paths (Herdr and tmux), also when maxMessageLength cuts the reply first, and before
 * sanitizeReplyInput adds its escapes (they double every backslash, which ends a quoted value too early).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
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
    tmuxExec: vi.fn(),
}));
vi.mock("../../cli/tmux-utils.js", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxExec: mocks.tmuxExec };
});
vi.mock("../../team/herdr-session.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        captureHerdrWorkerPane: mocks.captureHerdrWorkerPane,
        herdrSendPrompt: mocks.herdrSendPrompt,
        isHerdrWorkerAlive: mocks.isHerdrWorkerAlive,
    };
});
vi.mock("../../features/rate-limit-wait/tmux-detector.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        capturePaneContent: mocks.capturePaneContent,
        sendToPane: mocks.sendToPane,
    };
});
vi.mock("../session-registry.js", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, removeMessagesByPane: mocks.removeMessagesByPane };
});
import { quoteForCmd } from "../../cli/tmux-utils.js";
import { HerdrError, runHerdr } from "../../team/herdr-session.js";
import { buildReplyInjectionSteps, injectReplyIntoHerdrPane, processSlackSocketMessage, replyLogPreview, sanitizeReplyInput, sendReplyInjectionSteps, SlackConnectionStateTracker, RateLimiter, } from "../reply-listener.js";
const SWITCH = "OMC_REDACT_KEY_SHAPES";
const LOG_FILE = join(stateHome, "state", "reply-listener.log");
const configWith = (maxMessageLength, includePrefix = false) => ({ includePrefix, maxMessageLength });
// Keys that start so that exactly one character less than the minimum length of their shape lies inside the
// first 50 characters of the reply, and a JWT whose signature is cut to 7 characters.
const KEYS = [
    ["hf_", "hf_", 20, "hf_****"],
    ["xai-", "xai-", 20, "xai-****"],
    ["gsk_", "gsk_", 20, "gsk_****"],
    ["AIza", "AIza", 20, "AIza****"],
    ["sk-", "sk-", 8, "sk-****"],
];
const replyWithKeyAtTheCut = (key, minSuffix) => {
    const filler = "x".repeat(50 - key.length - (minSuffix - 1) - 1) + " ";
    return { text: `${filler}${key}${"a".repeat(minSuffix + 30)}`, filler };
};
const jwtAtTheCut = () => {
    const filler = "x".repeat(21) + " ";
    return { text: `${filler}eyJ${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(40)}`, filler };
};
/** The part of the last "Injected reply" log line that follows the pane id, without the timestamp. */
const loggedPreview = () => {
    const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const line = lines.filter((l) => l.includes("Injected reply from")).pop() ?? "";
    const match = line.match(/: "(.*)"$/);
    expect(match, `no preview in: ${line}`).not.toBeNull();
    return match[1];
};
let saved;
beforeEach(() => {
    saved = process.env[SWITCH];
    vi.clearAllMocks();
    rmSync(LOG_FILE, { force: true });
    mocks.captureHerdrWorkerPane.mockResolvedValue("Claude Code session output");
    mocks.herdrSendPrompt.mockResolvedValue(undefined);
    mocks.capturePaneContent.mockReturnValue("Claude Code session output");
    mocks.sendToPane.mockReturnValue(true);
    mocks.tmuxExec.mockReset();
    mocks.tmuxExec.mockReturnValue("");
});
afterEach(() => {
    if (saved === undefined)
        delete process.env[SWITCH];
    else
        process.env[SWITCH] = saved;
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
// The reply is typed in the sanitized form (control characters removed, line breaks as spaces, backslashes
// doubled, backticks and $( ${ escaped, trimmed). The log shows that form, but the redaction must see the reply
// without the doubled backslashes.
describe("replyLogPreview, switch on: every transformation of the reply, with every form of a quoted secret", () => {
    beforeEach(() => {
        process.env[SWITCH] = "1";
    });
    // [label, reply, preview]
    const CASES = [
        ["escaped quote (the example from review)", 'PASSWORD="start\\"sensitive-suffix"', 'PASSWORD="****"'],
        ["escaped quote, colon", 'PASSWORD: "start\\"sensitive-suffix"', 'PASSWORD: "****"'],
        ["escaped quote, spaces around the equals sign", 'PASSWORD = "start\\"sensitive-suffix"', 'PASSWORD = "****"'],
        ["escaped quote at the start of the value", 'TOKEN="\\"sensitive-suffix"', 'TOKEN="****"'],
        ["two escaped quotes", 'SECRET="a\\"b\\"sensitive-suffix" tail', 'SECRET="****" tail'],
        ["escaped quote, then a second assignment", 'PASSWORD="a\\"b" TOKEN="canary"', 'PASSWORD="****" TOKEN="****"'],
        ["an escaped backslash before the closing quote", 'PASSWORD="abc\\\\" tail', 'PASSWORD="****" tail'],
        ["a backslash in a bare value", "PASSWORD=ab\\cd tail", "PASSWORD=**** tail"],
        ["a backtick and $( in a quoted value", 'PASSWORD="a\\"`b`$(id)\\"c"', 'PASSWORD="****"'],
        ["a line break inside the quotes", 'PASSWORD="start\nsensitive-suffix"', 'PASSWORD="****"'],
        ["a line break after a bare value", "PASSWORD=canary\nnext", "PASSWORD=**** next"],
        ["a line break right after the equals sign", "PASSWORD=\ncanary", "PASSWORD= ****"],
        ["a line break right after the opening quote", 'PASSWORD="\ncanary"', 'PASSWORD="****"'],
        ["a control character inside the name", "PASS\u0001WORD=canary", "PASSWORD=****"],
        ["a bidi override inside the name, escaped quote", 'PASS\u202eWORD="a\\"sensitive-suffix"', 'PASSWORD="****"'],
    ];
    it.each(CASES)("%s", (_label, reply, preview) => {
        expect(replyLogPreview(reply, "slack", configWith(500))).toBe(preview);
        expect(replyLogPreview(reply, "slack", configWith(500, true))).toBe(`[reply:slack] ${preview}`);
    });
    it("spaces around the reply are trimmed, with or without the reply prefix", () => {
        const reply = '  PASSWORD="a\\"sensitive-suffix"  ';
        expect(replyLogPreview(reply, "slack", configWith(500))).toBe('PASSWORD="****"');
        expect(replyLogPreview(reply, "slack", configWith(500, true))).toBe('[reply:slack]   PASSWORD="****"');
    });
    it("the cut at maxMessageLength: the value is longer than the typed text", () => {
        const reply = `PASSWORD="start\\"${"s".repeat(60)}"`;
        expect(replyLogPreview(reply, "slack", configWith(30))).toBe('PASSWORD="****"');
        expect(replyLogPreview(reply, "slack", configWith(500))).toBe('PASSWORD="****"');
    });
    it("the cut at 50 characters: a key that starts at the cut of the escaped text", () => {
        // the doubled backslashes move the key: its first characters lie inside the first 50 characters of the escaped text
        const { text, filler } = replyWithKeyAtTheCut("hf_", 20);
        const escapedFiller = "\\\\".repeat(4) + filler.slice(8);
        const raw = "\\".repeat(4) + filler.slice(8) + text.slice(filler.length);
        expect(sanitizeReplyInput(raw).startsWith(`${escapedFiller}hf_`)).toBe(true);
        expect(replyLogPreview(raw, "slack", configWith(500))).toBe(`${escapedFiller}hf_****`);
    });
    it("the typed text is still the sanitized reply", () => {
        expect(sanitizeReplyInput('PASSWORD="start\\"sensitive-suffix"')).toBe('PASSWORD="start\\\\"sensitive-suffix"');
    });
});
describe("sanitizeReplyInput is what it was before it was split into two steps", () => {
    const before = (text) => text
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/\r\n|[\r\n]/g, " ")
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\(/g, "\\$(")
        .replace(/\$\{/g, "\\${")
        .trim();
    it("gives the same text for 3000 generated replies", () => {
        const pieces = ["a", " ", "\\", "`", "$(", "${", "$", "(", "{", "\n", "\r\n", "\r", "\t", "\u0001", "\u007f", "\u202e", "\u2066", '"', "'", "PASSWORD=", "x"];
        let seed = 99;
        const next = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        for (let t = 0; t < 3000; t++) {
            let text = "";
            const length = 1 + Math.floor(next() * 20);
            for (let k = 0; k < length; k++)
                text += pieces[Math.floor(next() * pieces.length)];
            expect(sanitizeReplyInput(text), JSON.stringify(text)).toBe(before(text));
        }
    });
});
describe("replyLogPreview, switch off: the preview is cut first and the output does not change", () => {
    it.each([undefined, "", "0", "true"])("with value %s", (value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        const legacy = (text, platform, config) => {
            const preview = sanitizeReplyInput((config.includePrefix ? `[reply:${platform}] ` : "") + text).slice(0, config.maxMessageLength);
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
            'PASSWORD="start\\"sensitive-suffix"',
            `  TOKEN: "a\\\\"\nb"  ${"w".repeat(60)}`,
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
    const EXACT = 'PASSWORD="start\\"sensitive-suffix"'; // the reply from review: backslash, quote, suffix
    it("Herdr path, escaped quote in a quoted secret: the suffix is not logged", async () => {
        await expect(injectReplyIntoHerdrPane("w9:p2", EXACT, "discord", configWith(500))).resolves.toBe(true);
        expect(mocks.herdrSendPrompt).toHaveBeenCalledWith("w9:p2", 'PASSWORD="start\\\\"sensitive-suffix"'); // typed with doubled backslash
        expect(loggedPreview()).toBe('PASSWORD="****"');
        expect(readFileSync(LOG_FILE, "utf-8")).not.toContain("sensitive-suffix");
    });
    const slackMessage = (text) => JSON.stringify({ type: "events_api", envelope_id: "E1", payload: { event: { type: "message", text } } });
    const processSlack = async (text, config) => {
        const connection = new SlackConnectionStateTracker();
        connection.onAuthenticated();
        const state = { errors: 0, messagesInjected: 0 };
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
    it("tmux path, escaped quote in a quoted secret: the suffix is not logged", async () => {
        await expect(processSlack(EXACT, configWith(500))).resolves.toBe(true);
        expect(mocks.sendToPane).toHaveBeenCalledWith("%5", 'PASSWORD="start\\\\"sensitive-suffix"', true);
        expect(loggedPreview()).toBe('PASSWORD="****"');
        expect(readFileSync(LOG_FILE, "utf-8")).not.toContain("sensitive-suffix");
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
    const stderrWithKeyAtTheCut = () => {
        // 278 characters, then hf_ and 19 characters of the key: character 300 falls inside the key
        const filler = "x".repeat(277) + " ";
        return { stderr: `${filler}hf_${"a".repeat(40)}\n`, filler };
    };
    const failingHerdr = (stderr) => runHerdr(["agent", "prompt", "w9:p2"], {
        env: {},
        execFn: (() => Promise.reject(Object.assign(new Error("exit 1"), { stderr }))),
    }).then(() => {
        throw new Error("runHerdr did not fail");
    }, (error) => error);
    const loggedLine = (needle) => {
        const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
        return (lines.filter((l) => l.includes(needle)).pop() ?? "").replace(/^\[[^\]]*\] /, "");
    };
    // A process that fails without printing anything: the error that runHerdr throws carries the message of the
    // failed process, which is its command line, and the command line holds the reply as it was typed.
    const failingWithCommandLine = (message) => runHerdr(["agent", "prompt", "w9:p2"], {
        env: {},
        execFn: (() => Promise.reject(Object.assign(new Error(message), { stderr: "" }))),
    }).then(() => {
        throw new Error("runHerdr did not fail");
    }, (error) => error);
    const REPLY = 'PASSWORD="start\\"sensitive-suffix"';
    const typed = (reply) => buildReplyInjectionSteps(reply, "discord", configWith(500))[0].value;
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
        it("send failure with empty stderr: the command line holds the typed reply, which is redacted as it was written", async () => {
            const message = `Command failed: herdr agent prompt w9:p2 ${typed(REPLY)}`;
            expect(message).toContain('start\\\\"sensitive-suffix'); // the typed reply has the doubled backslash
            mocks.herdrSendPrompt.mockRejectedValue(await failingWithCommandLine(message));
            await expect(injectReplyIntoHerdrPane("w9:p2", REPLY, "discord", configWith(500))).resolves.toBe(false);
            expect(loggedLine("Failed to inject")).toBe('ERROR: Failed to inject reply into herdr pane w9:p2: herdr_spawn_failed: Command failed: herdr agent prompt w9:p2 PASSWORD="****"');
        });
        it("capture failure with empty stderr: the message is not a typed reply, its backslashes stay", async () => {
            const message = "Command failed: herdr agent read w9:p2 C:\\\\temp\\\\x";
            mocks.captureHerdrWorkerPane.mockRejectedValue(await failingWithCommandLine(message));
            mocks.isHerdrWorkerAlive.mockResolvedValue(true);
            await expect(injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500))).resolves.toBe(false);
            expect(loggedLine("Failed to capture")).toBe(`WARN: Failed to capture herdr pane w9:p2: herdr_spawn_failed: ${message}`);
        });
        it("other errors keep their own message: a JSON error envelope, another error class, a value that is not an error", async () => {
            const cases = [
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
    it.each([undefined, "", "0", "true"])("switch off (%s): a failed prompt with empty stderr is logged as the error carries it", async (value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        const message = `Command failed: herdr agent prompt w9:p2 ${typed(REPLY)}`;
        mocks.herdrSendPrompt.mockRejectedValue(await failingWithCommandLine(message));
        await injectReplyIntoHerdrPane("w9:p2", REPLY, "discord", configWith(500));
        expect(loggedLine("Failed to inject")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_spawn_failed: ${message}`);
    });
    it.each([undefined, "", "0", "true"])("switch off (%s): the message is cut first, as the error carries it", async (value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        const { stderr, filler } = stderrWithKeyAtTheCut();
        mocks.herdrSendPrompt.mockRejectedValue(await failingHerdr(stderr));
        await injectReplyIntoHerdrPane("w9:p2", "hello", "discord", configWith(500));
        expect(loggedLine("Failed to inject")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: ${filler}hf_${"a".repeat(19)}`);
    });
});
// When tmux send-keys fails, the message of the error holds the command line, and the command line holds the
// reply as it was typed: with doubled backslashes. The log must mask the reply as the user wrote it.
describe("errors from tmux send-keys in the log", () => {
    const failWith = (typed) => {
        mocks.tmuxExec.mockImplementation(() => {
            throw new Error(`Command failed: tmux send-keys -t %5 -l ${typed}`);
        });
    };
    const sendFailureLine = () => {
        const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
        return (lines.filter((l) => l.includes("Failed to send reply injection steps")).pop() ?? "").replace(/^\[[^\]]*\] /, "");
    };
    const fail = (reply) => {
        const steps = buildReplyInjectionSteps(reply, "discord", configWith(500));
        failWith(steps[0].value);
        expect(sendReplyInjectionSteps("%5", steps)).toBe(false);
        return sendFailureLine();
    };
    describe("switch on", () => {
        beforeEach(() => {
            process.env[SWITCH] = "1";
        });
        it("an escaped quote in a quoted secret: the suffix is not logged", () => {
            expect(fail('PASSWORD="start\\"sensitive-suffix"')).toBe('ERROR: Failed to send reply injection steps to pane %5: Command failed: tmux send-keys -t %5 -l PASSWORD="****"');
        });
        it("the escapes are undone for the whole message and nothing else is changed", () => {
            const reply = "echo `x` $(id) ${HOME} \\ done PASSWORD=\"a\\\"b\"";
            expect(fail(reply)).toBe('ERROR: Failed to send reply injection steps to pane %5: Command failed: tmux send-keys -t %5 -l echo `x` $(id) ${HOME} \\ done PASSWORD="****"');
        });
        it("an error that is not an Error is logged as text", () => {
            mocks.tmuxExec.mockImplementation(() => {
                throw "plain failure";
            });
            expect(sendReplyInjectionSteps("%5", [{ kind: "literal", value: "x" }])).toBe(false);
            expect(sendFailureLine()).toBe("ERROR: Failed to send reply injection steps to pane %5: plain failure");
        });
    });
    it.each([undefined, "", "0", "true"])("switch off (%s): the message is logged as the error carries it", (value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        const reply = 'PASSWORD="start\\"sensitive-suffix"';
        expect(fail(reply)).toBe('ERROR: Failed to send reply injection steps to pane %5: Command failed: tmux send-keys -t %5 -l PASSWORD="start\\\\"sensitive-suffix"');
    });
});
// A failed `tmux send-keys` has the reply in the message of its error, in the form the command line has after every
// layer around it: the escapes of the typed text (escapeReplyInput) and, for a tmux that is a `.cmd` or `.bat`
// wrapper on native Windows, the quoting of quoteForCmd (resolveTmuxInvocation in tmux-utils.ts), which wraps the
// argument in quotes and doubles every `"` and `%`. Node builds the message in JavaScript as
// `Command failed: <file> <arguments joined by spaces>`, so it looks the same on every system, and the layers can
// be put around the text here, with the real quoteForCmd, on any system. The log must show the reply masked as it
// was written, in the same layers.
describe("errors from tmux send-keys in the log: every layer around the typed reply, with every form of a secret", () => {
    const WRAPPER = "C:\\Program Files\\psmux\\tmux.cmd";
    const COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    const cmdWrapperLine = (args) => `Command failed: ${COMSPEC} /d /s /c ${[WRAPPER, ...args].map(quoteForCmd).join(" ")}`;
    const LAYERS = [
        ["tmux started directly", (args) => `Command failed: tmux -u ${args.join(" ")}`],
        ["a native Windows tmux.exe", (args) => `Command failed: C:\\psmux\\tmux.exe ${args.join(" ")}`],
        ["a .cmd wrapper on native Windows (quoteForCmd)", cmdWrapperLine],
    ];
    // [label, reply, the reply masked]
    const FORMS = [
        ["bare assignment", "PASSWORD=canarysecret", "PASSWORD=****"],
        ["escaped quote (the example from review)", 'PASSWORD="start\\"sensitive-suffix"', 'PASSWORD="****"'],
        ["single quotes with a space", "TOKEN='two words'", "TOKEN='****'"],
        ["a quoted value with %, spaces, &, parentheses and escaped quotes", 'api_key="50% of \\"it\\" & (more)"', 'api_key="****"'],
        ["an escaped backslash before the closing quote", 'PASSWORD="abc\\\\" tail', 'PASSWORD="****" tail'],
        ["a backtick, $( and ${ in a quoted value", 'SECRET="a\\"`b`$(id)${x}\\"c"', 'SECRET="****"'],
        ["text around an escaped quote", 'please use PASSWORD="start\\"sensitive-suffix" thanks', 'please use PASSWORD="****" thanks'],
        ["key prefix", "sk-proj-abcdefghijklmnop", "sk-****"],
        ["key prefix inside a sentence", "use sk-proj-abcdefghijklmnop now", "use sk-**** now"],
        ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", "eyJ***"],
        ["a path with backslashes and a percent sign next to an assignment", "copy C:\\temp\\x.txt 100% PASSWORD=canary", "copy C:\\temp\\x.txt 100% PASSWORD=****"],
    ];
    const PREFIX = "[reply:discord] ";
    /** The text of the last send-keys failure in the log, from the word ERROR to the end of the message. */
    const loggedFailure = () => {
        const text = readFileSync(LOG_FILE, "utf-8");
        return text.slice(text.lastIndexOf("ERROR: Failed to send reply injection steps")).replace(/\n$/, "");
    };
    /** Types the reply, with every send-keys call failing with the message that `message` builds from its arguments. */
    const failThrough = (message, reply, includePrefix = false, tail = "", steps = buildReplyInjectionSteps(reply, "discord", configWith(500, includePrefix))) => {
        let sent = [];
        mocks.tmuxExec.mockImplementation((args) => {
            if (!args.includes("-l"))
                return "";
            sent = args;
            throw new Error(message(args) + tail);
        });
        expect(sendReplyInjectionSteps("%5", steps)).toBe(false);
        return { logged: loggedFailure(), sent };
    };
    const expected = (message, masked, includePrefix) => `ERROR: Failed to send reply injection steps to pane %5: ${message(["send-keys", "-t", "%5", "-l", (includePrefix ? PREFIX : "") + masked])}`;
    describe("switch on", () => {
        beforeEach(() => {
            process.env[SWITCH] = "1";
        });
        it.each(LAYERS)("%s: the reply is masked as it was written, with and without the reply prefix", (_name, message) => {
            for (const [label, reply, masked] of FORMS) {
                for (const includePrefix of [false, true]) {
                    expect(failThrough(message, reply, includePrefix).logged, `${label}, prefix ${includePrefix}`).toBe(expected(message, masked, includePrefix));
                }
            }
        });
        it("the example from review, through the .cmd wrapper: the quotes that quoteForCmd doubled do not end the value", () => {
            const { logged, sent } = failThrough(cmdWrapperLine, 'PASSWORD="start\\"sensitive-suffix"');
            expect(sent[sent.length - 1]).toBe('PASSWORD="start\\\\"sensitive-suffix"'); // typed with the doubled backslash
            expect(cmdWrapperLine(sent)).toContain('"PASSWORD=""start\\\\""sensitive-suffix"""'); // the doubled quotes
            expect(logged).toBe('ERROR: Failed to send reply injection steps to pane %5: Command failed: C:\\Windows\\System32\\cmd.exe /d /s /c "C:\\Program Files\\psmux\\tmux.cmd" send-keys -t "%%5" -l "PASSWORD=""****"""');
        });
        it.each(LAYERS)("%s: the steps that walk the question menu come first and the failing step is the typed reply", (_name, message) => {
            const mapping = { event: "ask-user-question", askUserQuestionOptionCount: 2, askUserQuestionAllowOther: true };
            const reply = 'PASSWORD="start\\"sensitive-suffix"';
            const steps = buildReplyInjectionSteps(reply, "discord", configWith(500), mapping);
            expect(steps.map((step) => step.kind)).toEqual(["key", "key", "key", "literal", "key"]);
            expect(failThrough(message, reply, false, "", steps).logged).toBe(expected(message, 'PASSWORD="****"', false));
        });
        it("what the command printed to stderr follows the first line and is kept, with the reply masked in the first line", () => {
            const tail = "\npsmux: can't find pane: %5";
            const { logged } = failThrough(cmdWrapperLine, 'PASSWORD="start\\"sensitive-suffix"', false, tail);
            expect(logged).toBe(`${expected(cmdWrapperLine, 'PASSWORD="****"', false)}${tail}`);
        });
        it("a real error of execFileSync through the .cmd quoting has the message that the grid builds", () => {
            const reply = 'PASSWORD="start\\"sensitive-suffix"';
            const steps = buildReplyInjectionSteps(reply, "discord", configWith(500));
            mocks.tmuxExec.mockImplementation((args) => {
                if (!args.includes("-l"))
                    return "";
                // Node runs the command and fails with `Command failed: <file> <arguments>` and the stderr of the command.
                execFileSync(process.execPath, ["/d", "/s", "/c", [WRAPPER, ...args].map(quoteForCmd).join(" ")], { encoding: "utf-8", stdio: "pipe" });
                return "";
            });
            expect(sendReplyInjectionSteps("%5", steps)).toBe(false);
            const logged = loggedFailure();
            expect(logged.split("\n")[0]).toBe(`ERROR: Failed to send reply injection steps to pane %5: Command failed: ${process.execPath} /d /s /c "C:\\Program Files\\psmux\\tmux.cmd" send-keys -t "%%5" -l "PASSWORD=""****"""`);
            expect(logged).not.toContain("sensitive-suffix");
        });
        it("a reply that quoteForCmd refuses (a NUL character) does not stop the log line", () => {
            const steps = [{ kind: "literal", value: "PASSWORD=a\u0000b" }];
            const { logged } = failThrough((args) => `Command failed: tmux -u ${args.join(" ")}`, "", false, "", [...steps]);
            expect(logged).toBe("ERROR: Failed to send reply injection steps to pane %5: Command failed: tmux -u send-keys -t %5 -l PASSWORD=****");
        });
        it("the Herdr path (no quoting layer): a failed prompt, with every form of a secret, in the command line and in an echo in stderr", async () => {
            const loggedHerdrFailure = () => {
                const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
                return (lines.filter((l) => l.includes("Failed to inject reply into herdr pane")).pop() ?? "").replace(/^\[[^\]]*\] /, "");
            };
            for (const [label, reply, masked] of FORMS) {
                for (const includePrefix of [false, true]) {
                    const typedText = buildReplyInjectionSteps(reply, "discord", configWith(500, includePrefix))[0].value;
                    const shown = (includePrefix ? PREFIX : "") + masked;
                    // empty stderr: the message is the command line of the process, logged with the escapes undone
                    mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("spawn_failed", `Command failed: herdr agent prompt w9:p2 ${typedText}`));
                    await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(500, includePrefix));
                    expect(loggedHerdrFailure(), `${label}, prefix ${includePrefix}, command line`).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_spawn_failed: Command failed: herdr agent prompt w9:p2 ${shown}`);
                    // stderr that echoes the typed text: kept as Herdr wrote it (the typed form), with the echo masked
                    const stderr = `cannot type ${typedText} into the pane\n`;
                    mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("error", stderr.trim(), stderr));
                    await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(500, includePrefix));
                    expect(loggedHerdrFailure(), `${label}, prefix ${includePrefix}, stderr`).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: cannot type ${sanitizeReplyInput(shown)} into the pane`);
                }
            }
        });
        it("a message that holds the reply in a form that is not known is masked as it was before: nothing is lost", () => {
            const { logged } = failThrough((args) => `Command failed: wrapper-that-is-not-known ${args.slice(0, 4).join(" ")} (${args[4].replace(/ /g, "+")}) PASSWORD=bare-secret`, "TOKEN=canary one");
            expect(logged).toBe("ERROR: Failed to send reply injection steps to pane %5: Command failed: wrapper-that-is-not-known send-keys -t %5 -l (TOKEN=****) PASSWORD=****");
        });
    });
    it.each(LAYERS.flatMap(([name, message]) => [undefined, "", "0", "true"].map((value) => [name, message, value])))("switch off, %s (%s): the message is logged as the error carries it", (_name, message, value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        for (const [label, reply] of FORMS) {
            const { logged, sent } = failThrough(message, reply);
            expect(logged, label).toBe(`ERROR: Failed to send reply injection steps to pane %5: ${message(sent)}`);
        }
    });
    it.each([undefined, "", "0", "true"])("switch off (%s): a Herdr prompt that fails with an echo of the typed reply in stderr is logged as the error carries it", async (value) => {
        if (value === undefined)
            delete process.env[SWITCH];
        else
            process.env[SWITCH] = value;
        const reply = 'PASSWORD="start\\"sensitive-suffix"';
        const typedText = buildReplyInjectionSteps(reply, "discord", configWith(500))[0].value;
        const stderr = `cannot type ${typedText} into the pane\n`;
        mocks.herdrSendPrompt.mockRejectedValue(new HerdrError("error", stderr.trim(), stderr));
        await injectReplyIntoHerdrPane("w9:p2", reply, "discord", configWith(500));
        const line = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter((l) => l.includes("Failed to inject reply into herdr pane")).pop() ?? "";
        expect(line.replace(/^\[[^\]]*\] /, "")).toBe(`ERROR: Failed to inject reply into herdr pane w9:p2: herdr_error: cannot type ${typedText} into the pane`);
    });
});
//# sourceMappingURL=reply-log-preview.test.js.map