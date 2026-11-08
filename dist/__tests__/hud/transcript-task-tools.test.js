/**
 * #4242: HUD todos from Claude Code's Task tools (TaskCreate / TaskUpdate).
 *
 * TaskCreate carries no id in its input; the id arrives in the paired
 * tool_result ("Task #<id> created successfully: <subject>"). TaskUpdate
 * addresses items by taskId. TodoWrite keeps its full-list replace semantics.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscript } from "../../hud/transcript.js";
import { renderTodosWithCurrent } from "../../hud/elements/todos.js";
const tempDirs = [];
let seq = 0;
afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});
function ts() {
    seq += 1;
    return new Date(Date.UTC(2026, 9, 6, 0, 0, seq)).toISOString();
}
function toolUse(id, name, input) {
    return {
        timestamp: ts(),
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    };
}
function toolResult(toolUseId, content, isError = false) {
    return {
        timestamp: ts(),
        message: {
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) },
            ],
        },
    };
}
function create(n, subject, extra = {}, name = "TaskCreate") {
    return [
        toolUse(`toolu_c${n}`, name, { subject, description: `${subject} details`, ...extra }),
        toolResult(`toolu_c${n}`, `Task #${n} created successfully: ${subject}`),
    ];
}
let updateSeq = 0;
function update(input, name = "TaskUpdate") {
    updateSeq += 1;
    const id = `toolu_u${updateSeq}`;
    return [toolUse(id, name, input), toolResult(id, "Updated task")];
}
async function parse(lines) {
    const dir = mkdtempSync(join(tmpdir(), "omc-hud-task-tools-"));
    tempDirs.push(dir);
    const p = join(dir, "transcript.jsonl");
    writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    return parseTranscript(p);
}
describe("HUD transcript — TaskCreate/TaskUpdate (#4242)", () => {
    it("renders the issue repro: 3 creates then TaskUpdate taskId 1 -> in_progress", async () => {
        const result = await parse([
            ...create(1, "Write parser", { activeForm: "Writing parser" }),
            ...create(2, "Add tests"),
            ...create(3, "Open PR"),
            ...update({ taskId: "1", status: "in_progress" }),
        ]);
        expect(result.todos).toEqual([
            { content: "Write parser", status: "in_progress", activeForm: "Writing parser" },
            { content: "Add tests", status: "pending" },
            { content: "Open PR", status: "pending" },
        ]);
        const rendered = renderTodosWithCurrent(result.todos);
        expect(rendered).toContain("0/3");
        expect(rendered).toContain("(working: Writing parser)");
    });
    it("tracks progress through completion and falls back to subject without activeForm", async () => {
        const result = await parse([
            ...create(1, "Write parser"),
            ...create(2, "Add tests"),
            ...update({ taskId: "1", status: "completed" }),
            ...update({ taskId: "2", status: "in_progress" }),
        ]);
        expect(result.todos.map((t) => t.status)).toEqual(["completed", "in_progress"]);
        const rendered = renderTodosWithCurrent(result.todos);
        expect(rendered).toContain("1/2");
        expect(rendered).toContain("(working: Add tests)");
    });
    it("applies subject and activeForm updates by id", async () => {
        const result = await parse([
            ...create(1, "Old subject"),
            ...update({ taskId: "1", subject: "New subject", activeForm: "Doing new subject" }),
        ]);
        expect(result.todos).toEqual([
            { content: "New subject", status: "pending", activeForm: "Doing new subject" },
        ]);
    });
    it("removes a task on status deleted, even when the update has no subject", async () => {
        const result = await parse([
            ...create(1, "Keep"),
            ...create(2, "Drop"),
            ...update({ taskId: "2", status: "deleted" }),
        ]);
        expect(result.todos.map((t) => t.content)).toEqual(["Keep"]);
    });
    it("ignores updates for unknown ids and unknown statuses", async () => {
        const result = await parse([
            ...create(1, "Only task"),
            ...update({ taskId: "99", status: "completed" }),
            ...update({ taskId: "1", status: "bogus" }),
        ]);
        expect(result.todos).toEqual([{ content: "Only task", status: "pending" }]);
    });
    it("accepts a numeric taskId", async () => {
        const result = await parse([
            ...create(7, "Numeric"),
            ...update({ taskId: 7, status: "completed" }),
        ]);
        expect(result.todos).toEqual([{ content: "Numeric", status: "completed" }]);
    });
    it("adds nothing when TaskCreate errors or its result never arrives", async () => {
        const result = await parse([
            toolUse("toolu_err", "TaskCreate", { subject: "Failed" }),
            toolResult("toolu_err", "Error: could not create task", true),
            toolUse("toolu_orphan", "TaskCreate", { subject: "Orphan" }),
        ]);
        expect(result.todos).toEqual([]);
    });
    it("reads the id from array-form tool_result content", async () => {
        const result = await parse([
            toolUse("toolu_arr", "TaskCreate", { subject: "Array result" }),
            toolResult("toolu_arr", [{ type: "text", text: "Task #4 created successfully: Array result" }]),
            ...update({ taskId: "4", status: "in_progress" }),
        ]);
        expect(result.todos).toEqual([{ content: "Array result", status: "in_progress" }]);
    });
    it("handles proxy_TaskCreate / proxy_TaskUpdate", async () => {
        const result = await parse([
            ...create(1, "Proxied", {}, "proxy_TaskCreate"),
            ...update({ taskId: "1", status: "completed" }, "proxy_TaskUpdate"),
        ]);
        expect(result.todos).toEqual([{ content: "Proxied", status: "completed" }]);
    });
    it("TodoWrite replaces the list and drops earlier task ids; later Task tools apply on top", async () => {
        const result = await parse([
            ...create(1, "From task tool"),
            toolUse("toolu_tw", "TodoWrite", {
                todos: [{ content: "From TodoWrite", status: "in_progress", activeForm: "Writing" }],
            }),
            ...update({ taskId: "1", status: "completed" }),
            ...create(2, "After TodoWrite"),
        ]);
        expect(result.todos).toEqual([
            { content: "From TodoWrite", status: "in_progress", activeForm: "Writing" },
            { content: "After TodoWrite", status: "pending" },
        ]);
    });
    it("keeps TodoWrite-only transcripts unchanged", async () => {
        const result = await parse([
            toolUse("toolu_tw", "TodoWrite", {
                todos: [
                    { content: "A", status: "completed" },
                    { content: "B", status: "pending" },
                ],
            }),
        ]);
        expect(result.todos.map((t) => [t.content, t.status])).toEqual([
            ["A", "completed"],
            ["B", "pending"],
        ]);
    });
});
//# sourceMappingURL=transcript-task-tools.test.js.map