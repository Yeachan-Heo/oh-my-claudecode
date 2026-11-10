/**
 * Test for issue #4933: opt-in model-routing for Agent/Task calls naming fable
 * 
 * Subprocess tests that run scripts/pre-tool-enforcer.mjs directly with
 * OMC_JEV_MODEL_ROUTING_FABLE on and off, inspecting the actual Jev request criteria.
 * Proves that Fable is only included in model choices when opt-in is enabled,
 * and that it's described as highest-complexity tier (not ultra-lightweight).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";
const TASK = "Execute a test task";

// Jev returns fable to test if it's rejected when opt-in is off
const JEV_ANSWERS = {
  "model-tier": { type: "choice", choice: "fable", confidence: 0.9 },
  effort: { type: "score", score: 2, confidence: 0.7 },
};

/**
 * Run pre-tool-enforcer.mjs subprocess and capture Jev requests
 */
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  return new Promise<{
    jevRequests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    const jevRequests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = [];
    let server: Server | null = null;

    const createServer_ = (): Promise<number> =>
      new Promise((resolvePort, rejectPort) => {
        server = createServer((request, response) => {
          let raw = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            raw += chunk;
          });
          request.on("end", () => {
            try {
              jevRequests.push(JSON.parse(raw));
              response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
              response.end(JSON.stringify({ answers: JEV_ANSWERS }));
            } catch (err) {
              response.writeHead(500);
              response.end();
              rejectPort(err);
            }
          });
        });
        server!.once("error", rejectPort);
        server!.listen(0, "127.0.0.1", () => {
          const address = server!.address();
          if (!address || typeof address === "string") {
            rejectPort(new Error("Expected TCP endpoint"));
          } else {
            resolvePort(address.port);
          }
        });
      });

    createServer_()
      .then((port) => {
        const cwd = mkdtempSync(join(tmpdir(), "jev-fable-"));
        mkdirSync(join(cwd, ".omc"), { recursive: true });

        const testEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: cwd,
          USERPROFILE: cwd,
          XDG_CONFIG_HOME: join(cwd, "config"),
          CLAUDE_CONFIG_DIR: join(cwd, "claude"),
          NODE_NO_WARNINGS: "1",
          OMC_DISABLE_MULTIREPO: "1",
          OMC_STATE_DIR: join(cwd, ".omc"),
          OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
          OMC_JEV_QUIET: "1",
          OMC_JEV_TIMEOUT_MS: "3000",
          OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: "0",
          TYPESAFE_API_KEY: API_KEY,
          OMC_JEV_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
          OMC_JEV: "model-routing:active",
          OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1",
          ...env,
        };

        const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
          cwd: PROJECT_ROOT,
          env: testEnv,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        });

        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);

        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });

        child.once("error", (error) => {
          clearTimeout(timeout);
          server?.close();
          rmSync(cwd, { recursive: true, force: true });
          reject(error);
        });

        child.once("close", (code) => {
          clearTimeout(timeout);
          server?.close();
          rmSync(cwd, { recursive: true, force: true });
          resolve({
            jevRequests,
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        });

        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify(input));
      })
      .catch(reject);
  });
}

describe("issue #4933: opt-in fable model routing (subprocess)", () => {
  function agentInput(prompt: string = TASK, extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Execute test task",
        prompt,
        subagent_type: "general-purpose",
        ...extra,
      },
      cwd: PROJECT_ROOT,
      session_id: "test-session",
    };
  }

  it("should NOT include fable criteria in Jev questions by default", async () => {
    const result = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: undefined,
    });

    expect(result.jevRequests.length, `stderr: ${result.stderr}`).toBeGreaterThan(0);

    const modelRoutingRequest = result.jevRequests.find((req) =>
      req.questions && req.questions["model-tier"]
    );
    expect(modelRoutingRequest, "Should have model-tier question").toBeDefined();

    if (modelRoutingRequest) {
      const criteria = (modelRoutingRequest.questions["model-tier"] as Record<string, unknown>)?.criteria || {};
      expect(Object.keys(criteria), "Should include standard tiers").toContain("haiku");
      expect(Object.keys(criteria), "Should include standard tiers").toContain("sonnet");
      expect(Object.keys(criteria), "Should include standard tiers").toContain("opus");
      // Without opt-in, fable should NOT be in criteria
      expect(Object.keys(criteria), "fable should NOT be in criteria without opt-in").not.toContain("fable");
    }
  }, 30000);

  it("should include fable criteria with highest-complexity descriptor when opt-in is enabled", async () => {
    const result = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: "1",
    });

    expect(result.jevRequests.length, `stderr: ${result.stderr}`).toBeGreaterThan(0);

    const modelRoutingRequest = result.jevRequests.find((req) =>
      req.questions && req.questions["model-tier"]
    );
    expect(modelRoutingRequest, "Should have model-tier question").toBeDefined();

    if (modelRoutingRequest) {
      const criteria = (modelRoutingRequest.questions["model-tier"] as Record<string, unknown>)?.criteria || {};
      expect(Object.keys(criteria), "fable should be in criteria with opt-in").toContain("fable");
      const fableDescriptor = criteria.fable as string;
      // Fable must be described as highest-complexity, not ultra-lightweight
      expect(fableDescriptor, "Fable should be highest-complexity tier").toMatch(/highest-complexity/i);
      expect(fableDescriptor, "Fable should be for exceptionally demanding work").toMatch(/exceptionally demanding/i);
      // Ensure it does NOT use the old wrong description
      expect(fableDescriptor, "Should not use old ultra-lightweight description").not.toMatch(/ultra-lightweight|simple.*tasks/i);
    }
  }, 30000);

  it("only the values '1' or 'true' enable fable, other values do not", async () => {
    const disabledValues = ["yes", "0", ""];
    const disabledResults = await Promise.all(
      disabledValues.map((value) =>
        runEnforcer(agentInput(), {
          OMC_JEV_MODEL_ROUTING_FABLE: value,
        })
      )
    );

    // All with non-'1'/'true' values should NOT have fable in criteria
    disabledResults.forEach((result, index) => {
      const value = disabledValues[index];
      const modelRoutingRequest = result.jevRequests.find((req) =>
        req.questions && req.questions["model-tier"]
      );
      expect(modelRoutingRequest, `Should have model-tier question for value="${value}"`).toBeDefined();
      const criteria = (modelRoutingRequest!.questions["model-tier"] as Record<string, unknown>)?.criteria || {};
      expect(
        Object.keys(criteria),
        `fable should NOT be in criteria with value="${value}"`
      ).not.toContain("fable");
    });

    // Test with '1' - should enable fable
    const enabledResult1 = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: "1",
    });
    const modelRoutingRequest1 = enabledResult1.jevRequests.find((req) =>
      req.questions && req.questions["model-tier"]
    );
    expect(modelRoutingRequest1, 'Should have model-tier question for value="1"').toBeDefined();
    const criteria1 = (modelRoutingRequest1!.questions["model-tier"] as Record<string, unknown>)?.criteria || {};
    expect(Object.keys(criteria1), `fable should be in criteria with value="1"`).toContain("fable");

    // Test with 'true' - should also enable fable
    const enabledResultTrue = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: "true",
    });
    const modelRoutingRequestTrue = enabledResultTrue.jevRequests.find((req) =>
      req.questions && req.questions["model-tier"]
    );
    expect(modelRoutingRequestTrue, 'Should have model-tier question for value="true"').toBeDefined();
    const criteriaTrue = (modelRoutingRequestTrue!.questions["model-tier"] as Record<string, unknown>)?.criteria || {};
    expect(Object.keys(criteriaTrue), `fable should be in criteria with value="true"`).toContain("fable");
  }, 90000);

  it("should reject fable when Jev suggests it but opt-in is disabled", async () => {
    const result = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: undefined,
    });

    // Validate subprocess success and output are present before parsing
    expect(result.exitCode, `subprocess failed with stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout, "subprocess must produce valid JSON output").toBeTruthy();
    
    // Parse and validate the output to check if fable was rejected
    const output = JSON.parse(result.stdout);
    const routedModel = output.hookSpecificOutput?.updatedInput?.model;
    // With opt-in disabled, fable should be rejected
    expect(routedModel, "fable should not be accepted without opt-in").not.toBe("fable");
  }, 30000);

  it("should accept fable when Jev suggests it and opt-in is enabled", async () => {
    const result = await runEnforcer(agentInput(), {
      OMC_JEV_MODEL_ROUTING_FABLE: "1",
    });

    // Validate subprocess success and output are present before parsing
    expect(result.exitCode, `subprocess failed with stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout, "subprocess must produce valid JSON output").toBeTruthy();
    
    // Parse and validate the output to check if fable was accepted
    const output = JSON.parse(result.stdout);
    const routedModel = output.hookSpecificOutput?.updatedInput?.model;
    // With opt-in enabled, fable should be accepted
    expect(routedModel, "fable should be accepted with opt-in").toBe("fable");
  }, 30000);

  it("should enforce opt-in gate for calls that explicitly name fable (opt-in enabled)", async () => {
    const result = await runEnforcer(agentInput(TASK, { model: "fable" }), {
      OMC_JEV_MODEL_ROUTING_FABLE: "1",
      OMC_JEV_MODEL_ROUTING_ALL_AGENTS: undefined,
    });

    // Validate subprocess success and output are present before parsing
    expect(result.exitCode, `subprocess failed with stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout, "subprocess must produce valid JSON output").toBeTruthy();
    
    // Parse and validate that explicit fable is accepted when opt-in is enabled
    const output = JSON.parse(result.stdout);
    const routedModel = output.hookSpecificOutput?.updatedInput?.model;
    // With explicit model='fable' and opt-in enabled, fable should be preserved
    expect(routedModel, "explicit fable should be accepted with opt-in").toBe("fable");
  }, 30000);

  it("should enforce opt-in gate for calls that explicitly name fable (opt-in disabled)", async () => {
    const result = await runEnforcer(agentInput(TASK, { model: "fable" }), {
      OMC_JEV_MODEL_ROUTING_FABLE: undefined,
      OMC_JEV_MODEL_ROUTING_ALL_AGENTS: undefined,
    });

    // Validate subprocess success and output are present before parsing
    expect(result.exitCode, `subprocess failed with stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout, "subprocess must produce valid JSON output").toBeTruthy();
    
    // Parse and validate that explicit fable is rejected when opt-in is disabled
    const output = JSON.parse(result.stdout);
    const routedModel = output.hookSpecificOutput?.updatedInput?.model;
    // With explicit model='fable' but opt-in disabled, fable should be replaced with fallback
    expect(routedModel, "explicit fable should be rejected without opt-in").not.toBe("fable");
  }, 30000);
});
