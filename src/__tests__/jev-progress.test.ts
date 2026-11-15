import { describe, expect, it } from "vitest";
import { MAX_BLOCKS_WITHOUT_PROGRESS, ProgressState, classifyTranscript, isAcknowledgedBlockedExit, normalizeSignature } from "../../scripts/lib/jev-progress.mjs";

const add = (p: ProgressState, call: unknown): { progress: boolean; reason: string } => p.add(call);

describe("jev-progress module", () => {
  it("classifies saved paths, reads, error signatures and failure-turned-success", () => {
    const p = new ProgressState();
    expect(add(p, { tool: "Write", input: { file_path: "/p/a.md" } })).toEqual({ progress: true, reason: "new-path" });
    expect(add(p, { tool: "Edit", input: { file_path: "  /p/a.md  " } })).toEqual({ progress: false, reason: "same-path" });
    expect(add(p, { tool: "Read", input: { file_path: "/p/a.md" } })).toEqual({ progress: false, reason: "read-only" });
    expect(add(p, { tool: "TodoWrite", input: { todos: [] } })).toEqual({ progress: false, reason: "read-only" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "Error: missing module xyz", ok: false })).toEqual({ progress: true, reason: "new-error" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "Error: missing module xyz", ok: false })).toEqual({ progress: false, reason: "error-repeat" });
    const p2 = new ProgressState();
    p2.add({ tool: "Bash", input: { command: "npm test" }, result: "Error: missing module xyz", ok: false });
    expect(add(p2, { tool: "Bash", input: { command: "npm test" }, result: "OK", ok: true })).toEqual({ progress: true, reason: "failure-success" });
  });

  it("tracks the test record in both directions with the first-summary case", () => {
    const p = new ProgressState();
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "5 tests passed", ok: true })).toEqual({ progress: true, reason: "test-record" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "8 tests passed", ok: true })).toEqual({ progress: true, reason: "test-record" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "8 tests passed", ok: true })).toEqual({ progress: false, reason: "no-record" });
    expect(add(p, { tool: "Bash", input: { command: "npm t" }, result: "1 failing" })).toEqual({ progress: true, reason: "test-record" });
    expect(add(p, { tool: "Bash", input: { command: "npm t" }, result: "3 failing" })).toEqual({ progress: false, reason: "no-record" });
    expect(add(p, { tool: "Bash", input: { command: "npm t" }, result: "0 failing" })).toEqual({ progress: true, reason: "test-record" });
  });

  it("reports progress when more than one sign applies and still updates the state", () => {
    const p = new ProgressState();
    // A failed run whose summary does not beat the record but whose error signature is new.
    p.add({ tool: "Bash", input: { command: "npm t" }, result: "2 failing", ok: true });
    expect(add(p, { tool: "Bash", input: { command: "npm t" }, result: "5 failing: boom", ok: false })).toEqual({ progress: true, reason: "new-error" });
    // A repeated error on a call that ran for at least a minute.
    expect(add(p, { tool: "Bash", input: { command: "npm t" }, result: "5 failing: boom", ok: false, durationMs: 61000 })).toEqual({ progress: true, reason: "long-call" });
    // A same-path save that failed with a new error.
    p.add({ tool: "Write", input: { file_path: "/p/a.md" } });
    expect(add(p, { tool: "Write", input: { file_path: "/p/a.md" }, result: "EACCES: permission denied, open", ok: false })).toEqual({ progress: true, reason: "new-error" });
    // A failing summary that fails the same call remembers it: the later success is progress.
    const q = new ProgressState();
    q.add({ tool: "Bash", input: { command: "make" }, result: "9 failing", ok: false });
    expect(add(q, { tool: "Bash", input: { command: "make" }, result: "9 failing", ok: false })).toEqual({ progress: false, reason: "no-record" });
    expect(add(q, { tool: "Bash", input: { command: "make" }, result: "12 passed", ok: true })).toEqual({ progress: true, reason: "test-record" });
    expect(q.state().failedKeys).toHaveLength(0);
  });

  it("does not count read-only calls as progress and a failure without result text stays quiet", () => {
    const p = new ProgressState();
    for (let i = 0; i < 5; i++) expect(add(p, { tool: "Read", input: { file_path: "/p/f" + i + ".ts" } })).toEqual({ progress: false, reason: "read-only" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "Error: EACCES permission denied", ok: false })).toEqual({ progress: true, reason: "new-error" });
    expect(add(p, { tool: "Bash", input: { command: "npm test" }, result: "Error: EACCES permission denied", ok: false })).toEqual({ progress: false, reason: "error-repeat" });
    expect(add(p, { tool: "Bash", input: { command: "false" }, ok: false })).toEqual({ progress: false, reason: "no-result" });
  });

  it("normalizes volatile parts of an error text to a stable signature", () => {
    const a = normalizeSignature("Error at /tmp/abc123/x.js:42 on 2026-11-14T10:20:30Z id 0123456789abcdef0123 uuid 123e4567-e89b-12d3-a456-426614174000");
    const b = normalizeSignature("Error at /tmp/zzz999/x.js:77 on 2025-01-02T03:04:05Z id fedcba9876543210fedc uuid 223e4567-e89b-12d3-a456-426614174999");
    expect(a).toBe(b);
  });

  it("counts long calls as progress at the 60 second boundary", () => {
    const p = new ProgressState();
    expect(add(p, { tool: "Bash", input: { command: "date" }, durationMs: 60000, ok: true })).toEqual({ progress: true, reason: "long-call" });
    expect(add(p, { tool: "Bash", input: { command: "date" }, durationMs: 59990, ok: true })).toEqual({ progress: false, reason: "none" });
    expect(add(p, { tool: "Bash", input: { command: "date" }, durationMs: Number.NaN, ok: true })).toEqual({ progress: false, reason: "none" });
  });

  it("a guard denial overrides every other sign, including a new saved path", () => {
    const p = new ProgressState();
    expect(add(p, { tool: "Write", input: { file_path: "/p/new.md" }, result: "[DENIED 1a2b3c4d5e6f7a8b #2] guard denial text", ok: true })).toEqual({ progress: false, reason: "guard-denial" });
  });

  it("caps every accumulator list to its newest 64 entries", () => {
    const p = new ProgressState();
    for (let i = 1; i <= 65; i++) p.add({ tool: "Write", input: { file_path: "/p/f" + i + ".md" } });
    const st = p.state();
    expect(st.paths).toHaveLength(64);
    expect(st.paths).not.toContain("/p/f1.md");
    expect(st.paths).toContain("/p/f65.md");
  });

  it("handles edge cases: non-object input, empty paths, result part arrays", () => {
    const p = new ProgressState();
    expect(add(p, { tool: "Bash", input: "not-object", result: "x", ok: true })).toEqual({ progress: false, reason: "none" });
    expect(add(p, { tool: "Bash" })).toEqual({ progress: false, reason: "none" });
    expect(add(p, { tool: "Write", input: { file_path: "   " }, result: [{ type: "text", text: "saved" }], ok: true })).toEqual({ progress: false, reason: "none" });
  });

  it("pairs transcript tool calls with and without timestamps and skips a truncated line", () => {
    const use = (ts: string, id: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: "/x/a.md" } }] } });
    const res = (ts: string, id: string) => JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    const r1 = classifyTranscript(use(new Date(1000).toISOString(), "tu1") + "\n" + res(new Date(62000).toISOString(), "tu1") + "\n", new ProgressState());
    expect(r1).toEqual({ calls: 2, progress: true });
    const undated = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: "/x/b.md" } }] } }) + "\n";
    const r2 = classifyTranscript(undated, new ProgressState());
    expect(r2).toEqual({ calls: 0, progress: false });
    const r3 = classifyTranscript(use(new Date(1000).toISOString(), "tu3") + "\n" + "{\"type\":\"assist", new ProgressState());
    expect(r3).toEqual({ calls: 1, progress: true });
  });

  it("does not count guard denials in a transcript as progress", () => {
    const rows: string[] = [];
    for (let i = 1; i <= 3; i++) {
      rows.push(JSON.stringify({ type: "assistant", timestamp: new Date(i * 31000).toISOString(), message: { content: [{ type: "tool_use", id: "tu-" + i, name: "Bash", input: { command: "date" } }] } }));
      rows.push(JSON.stringify({ type: "user", timestamp: new Date(i * 31000 + 100).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "tu-" + i, is_error: true, content: "Guard stopped the call. [denied 0123456789abcdef #" + i + "]" }] } }));
    }
    expect(classifyTranscript(rows.join("\n") + "\n", new ProgressState())).toEqual({ calls: 3, progress: false });
  });

  it("accepts only well-formed acknowledged blocked exits", () => {
    const yes = (t: string) => expect(isAcknowledgedBlockedExit(t)).toBe(true);
    const no = (t: string) => expect(isAcknowledgedBlockedExit(t)).toBe(false);
    yes("BLOCKED: no access to the production server and its API key");
    yes("blocked: no access to the production server and its key");
    yes("- BLOCKED: cannot run the test suite without network access");
    yes("> **BLOCKED:** production is frozen for the schema migration");
    yes("BLOCKED:** production is frozen for the schema migration");
    yes("Report first.\nBLOCKED: no access to the production server");
    no("Blocked tasks: none so far, continuing with the next story.");
    no("**Blocked** by nothing, going on with story 3 now");
    no("Status: blocked. Report: cannot finish, the server and its key are unreachable.");
    no("  ");
    no("BLOCKED: short");
    no("BLOCKED: <reason, at least 20 characters>");
    no("BLOCKED: Reason, at least 20 characters");
  });

  it("releases the Stop only past the threshold of six blocks without progress", () => {
    expect(MAX_BLOCKS_WITHOUT_PROGRESS).toBe(6);
  });
});
