import { describe, it, expect } from "vitest";
import { pythonReplTool } from "../tool.js";
import { pythonReplTool as pythonReplToolIndex } from "../index.js";
import { buildListToolsResponse } from "../../../mcp/tool-registry.js";
// Terms the tool must never advertise: the bridge sandbox blocks every import
// and prebinds no third-party module, so claiming scientific-computing support
// would be false advertising (issue #3682).
const ADVERTISED_SCIENCE_TERMS = [
    "scientific computing",
    "pandas",
    "numpy",
    "matplotlib",
];
function assertNoScientificAdvertising(description) {
    const lower = description.toLowerCase();
    for (const term of ADVERTISED_SCIENCE_TERMS) {
        expect(lower, `description must not advertise "${term}"`).not.toContain(term);
    }
}
describe("python_repl description parity (#3682)", () => {
    it("MCP-facing description (tool.ts) states the sandbox boundary instead of advertising scientific modules", () => {
        const description = pythonReplTool.description;
        assertNoScientificAdvertising(description);
        const lower = description.toLowerCase();
        expect(lower).toContain("imports");
        expect(lower).toContain("file i/o");
        expect(lower).toContain("dynamic code execution");
        expect(lower).toContain("blocked");
    });
    it("index.ts description does not advertise scientific modules", () => {
        assertNoScientificAdvertising(pythonReplToolIndex.description);
    });
    it("standalone MCP ListTools surface serves the truthful description", () => {
        // Exercises buildListToolsResponse(), the exact function the ListTools
        // handler calls, so the MCP-facing surface cannot drift from tool.ts.
        const { tools } = buildListToolsResponse("");
        const python = tools.find((t) => t.name === "python_repl");
        expect(python).toBeDefined();
        assertNoScientificAdvertising(python.description);
    });
});
//# sourceMappingURL=description-parity.test.js.map