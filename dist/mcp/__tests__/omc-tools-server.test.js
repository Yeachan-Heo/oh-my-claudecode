import { describe, expect, it } from "vitest";
import { _getAllToolNamesForTests } from "../omc-tools-server.js";
const RETIRED_MERGE_READINESS_TOOLS = [
    "merge_readiness_start",
    "merge_readiness_set_content",
    "merge_readiness_record_answer",
    "merge_readiness_report",
    "merge_readiness_cancel",
];
describe("OMC tools MCP server", () => {
    it("does not register retired merge-readiness tools", () => {
        const toolNames = _getAllToolNamesForTests();
        for (const name of RETIRED_MERGE_READINESS_TOOLS) {
            expect(toolNames).not.toContain(`mcp__t__${name}`);
        }
    });
});
//# sourceMappingURL=omc-tools-server.test.js.map