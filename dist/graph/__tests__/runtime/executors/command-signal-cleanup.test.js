/**
 * Graph run signal cleanup (OMC_GRAPH_SIGNAL_CLEANUP=1).
 *
 * The cleanup keeps module-level state (`interrupted`, the active-child set),
 * so every test loads a fresh copy of the command executor module and removes
 * the SIGINT/SIGTERM listeners it installed. `process.exit` is mocked: the
 * handler is exercised in-process with `process.emit`, never with a real
 * signal sent to the test worker. The only real processes are short `node`
 * children standing in for a running graph node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
const SIGNALS = ["SIGINT", "SIGTERM"];
const SWITCH = "OMC_GRAPH_SIGNAL_CLEANUP";
/** Forward slashes inside a single-quoted JS string in a node -e one-liner (Windows backslashes would be escapes). */
const slash = (path) => path.split(sep).join("/");
let listenersBefore;
let exitSpy;
let previousSwitch;
let workDir;
async function loadCommand() {
    vi.resetModules();
    return import("../../../runtime/executors/command.js");
}
function commandNode(command) {
    return {
        id: "cmd",
        kind: "command",
        title: "Command node",
        timeout_ms: 60_000,
        max_attempts: 3,
        effect_policy: { policy: "side_effect_free" },
        command,
    };
}
function contextFor(node) {
    const descriptor = {
        descriptor_version: 1,
        run_id: "run-signal",
        revision_id: "rev-signal",
        goal: "signal cleanup",
        nodes: [node],
        edges: [],
        entry_node_ids: [node.id],
        concurrency_limit: 1,
        terminal_verification_node_id: node.id,
        descriptor_hash: "a".repeat(64),
    };
    return { descriptor, node, activation_id: "act-1", attempt_id: "att-1", attempt_no: 1 };
}
/** Resolves true when `promise` settles within `ms`, false otherwise. */
async function settlesWithin(promise, ms) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), ms));
    return Promise.race([promise.then(() => true, () => true), timeout]);
}
async function waitFor(condition, ms) {
    const deadline = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > deadline)
            throw new Error("condition not reached in time");
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
beforeEach(() => {
    previousSwitch = process.env[SWITCH];
    delete process.env[SWITCH];
    listenersBefore = Object.fromEntries(SIGNALS.map((name) => [name, process.listeners(name)]));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined));
    workDir = realpathSync(mkdtempSync(join(tmpdir(), "graph-signal-cleanup-")));
});
afterEach(() => {
    exitSpy.mockRestore();
    for (const name of SIGNALS) {
        for (const listener of process.listeners(name)) {
            if (!listenersBefore[name].includes(listener)) {
                process.removeListener(name, listener);
            }
        }
    }
    if (previousSwitch === undefined)
        delete process.env[SWITCH];
    else
        process.env[SWITCH] = previousSwitch;
    rmSync(workDir, { recursive: true, force: true });
});
describe("installGraphSignalCleanup", () => {
    it("is off unless the switch is exactly \"1\": no handler, no AbortSignal", async () => {
        const { installGraphSignalCleanup } = await loadCommand();
        for (const value of [undefined, "0", "true", "", " 1", "1 ", "01"]) {
            if (value === undefined)
                delete process.env[SWITCH];
            else
                process.env[SWITCH] = value;
            expect(installGraphSignalCleanup(), `value ${JSON.stringify(value)}`).toBeUndefined();
        }
        for (const name of SIGNALS) {
            expect(process.listeners(name)).toEqual(listenersBefore[name]);
        }
    });
    it("with the switch on, returns an AbortSignal and SIGTERM with no active child exits 143", async () => {
        process.env[SWITCH] = "1";
        const { installGraphSignalCleanup } = await loadCommand();
        const signal = installGraphSignalCleanup();
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        process.emit("SIGTERM", "SIGTERM");
        expect(signal?.aborted).toBe(true);
        expect(String((signal?.reason).message)).toBe("graph run interrupted by SIGTERM");
        expect(exitSpy).toHaveBeenCalledWith(143);
    });
    it("SIGINT with no active child exits 130", async () => {
        process.env[SWITCH] = "1";
        const { installGraphSignalCleanup } = await loadCommand();
        installGraphSignalCleanup();
        process.emit("SIGINT", "SIGINT");
        expect(exitSpy).toHaveBeenCalledWith(130);
    });
    it("a second signal after the first one is ignored", async () => {
        process.env[SWITCH] = "1";
        const { installGraphSignalCleanup } = await loadCommand();
        installGraphSignalCleanup();
        process.emit("SIGTERM", "SIGTERM");
        process.emit("SIGINT", "SIGINT");
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(143);
    });
});
describe("CommandNodeExecutor with the signal cleanup", () => {
    it("without the switch a command runs as before and reports succeeded", async () => {
        const { CommandNodeExecutor } = await loadCommand();
        const node = commandNode('node -e "process.exit(0)"');
        const output = await new CommandNodeExecutor().execute(contextFor(node));
        expect(output.outcome).toBe("succeeded");
    });
    it("SIGTERM stops a running child, exits 143 after it closes, and its result is never committed", async () => {
        process.env[SWITCH] = "1";
        const { CommandNodeExecutor, installGraphSignalCleanup } = await loadCommand();
        installGraphSignalCleanup();
        const started = join(workDir, "started");
        const node = commandNode(`node -e "require('node:fs').writeFileSync('${slash(started)}', 'x'); setInterval(() => {}, 1000)"`);
        const execution = new CommandNodeExecutor().execute(contextFor(node));
        await waitFor(() => existsSync(started), 30_000);
        process.emit("SIGTERM", "SIGTERM");
        await waitFor(() => exitSpy.mock.calls.length > 0, 20_000);
        expect(exitSpy).toHaveBeenCalledWith(143);
        // The child was stopped by the interrupt; its outcome must not be committed.
        expect(await settlesWithin(execution, 300)).toBe(false);
    }, 60_000);
    it("after an interrupt a new node never starts and its promise never settles", async () => {
        process.env[SWITCH] = "1";
        const { CommandNodeExecutor, installGraphSignalCleanup } = await loadCommand();
        installGraphSignalCleanup();
        process.emit("SIGINT", "SIGINT");
        const marker = join(workDir, "must-not-start");
        const node = commandNode(`node -e "require('node:fs').writeFileSync('${slash(marker)}', 'x')"`);
        const execution = new CommandNodeExecutor().execute(contextFor(node));
        expect(await settlesWithin(execution, 300)).toBe(false);
        expect(existsSync(marker)).toBe(false);
    });
});
//# sourceMappingURL=command-signal-cleanup.test.js.map