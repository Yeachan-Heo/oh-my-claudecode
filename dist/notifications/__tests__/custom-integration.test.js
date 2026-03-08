/**
 * Custom Integration Tests
 *
 * Tests for validation, template interpolation, and dispatch
 * of custom webhook and CLI integrations.
 */
import { describe, it, expect } from "vitest";
import { validateCustomIntegration, checkDuplicateIds, sanitizeArgument, } from "../validation.js";
import { interpolateTemplate } from "../template-engine.js";
import { CUSTOM_INTEGRATION_PRESETS, getPreset } from "../presets.js";
import { getVariablesForEvent } from "../template-variables.js";
describe("Custom Integration Validation", () => {
    describe("validateCustomIntegration", () => {
        it("accepts valid webhook integration", () => {
            const integration = {
                id: "my-webhook",
                type: "webhook",
                enabled: true,
                config: {
                    url: "https://example.com/webhook",
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    bodyTemplate: '{"event":"{{event}}"}',
                    timeout: 10000,
                },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
        it("accepts valid CLI integration", () => {
            const integration = {
                id: "my-cli",
                type: "cli",
                enabled: true,
                config: {
                    command: "curl",
                    args: ["-X", "POST", "-d", "event={{event}}", "https://example.com"],
                    timeout: 5000,
                },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
        it("rejects integration without ID", () => {
            const integration = {
                id: "",
                type: "webhook",
                enabled: true,
                config: { url: "https://example.com", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain("Integration ID is required");
        });
        it("rejects integration with invalid ID characters", () => {
            const integration = {
                id: "my/webhook",
                type: "webhook",
                enabled: true,
                config: { url: "https://example.com", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("alphanumeric"))).toBe(true);
        });
        it("rejects HTTP URLs for webhooks (requires HTTPS)", () => {
            const integration = {
                id: "insecure-webhook",
                type: "webhook",
                enabled: true,
                config: { url: "http://example.com/webhook", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("HTTPS"))).toBe(true);
        });
        it("allows HTTP for localhost", () => {
            const integration = {
                id: "local-webhook",
                type: "webhook",
                enabled: true,
                config: { url: "http://localhost:3000/webhook", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(true);
        });
        it("allows HTTP for 127.0.0.1 loopback", () => {
            const integration = {
                id: "loopback-webhook",
                type: "webhook",
                enabled: true,
                config: { url: "http://127.0.0.1:8787/hook", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(true);
        });
        it("rejects CLI command with spaces", () => {
            const integration = {
                id: "bad-cli",
                type: "cli",
                enabled: true,
                config: { command: "curl -X POST", args: [], timeout: 5000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("spaces"))).toBe(true);
        });
        it("rejects CLI command with shell metacharacters", () => {
            const integration = {
                id: "bad-cli",
                type: "cli",
                enabled: true,
                config: { command: "curl;rm", args: [], timeout: 5000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
        });
        it("rejects arguments with shell metacharacters outside templates", () => {
            const integration = {
                id: "bad-args",
                type: "cli",
                enabled: true,
                config: { command: "curl", args: ["-d", "data;rm -rf /"], timeout: 5000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("metacharacters"))).toBe(true);
        });
        it("allows shell metacharacters inside template syntax", () => {
            const integration = {
                id: "template-args",
                type: "cli",
                enabled: true,
                config: { command: "curl", args: ["-d", "data={{complex;value}}"], timeout: 5000 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            // Should be valid because metacharacters are inside {{template}}
            expect(result.errors).not.toContain(expect.stringContaining("metacharacters"));
        });
        it("rejects timeout outside bounds", () => {
            const integration = {
                id: "bad-timeout",
                type: "webhook",
                enabled: true,
                config: { url: "https://example.com", method: "POST", headers: {}, bodyTemplate: "", timeout: 100 },
                events: ["session-end"],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes("Timeout"))).toBe(true);
        });
        it("rejects integration without events", () => {
            const integration = {
                id: "no-events",
                type: "webhook",
                enabled: true,
                config: { url: "https://example.com", method: "POST", headers: {}, bodyTemplate: "", timeout: 10000 },
                events: [],
            };
            const result = validateCustomIntegration(integration);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain("At least one event must be selected");
        });
    });
    describe("checkDuplicateIds", () => {
        it("returns empty array when no duplicates", () => {
            const integrations = [
                { id: "webhook-1", type: "webhook", enabled: true, config: {}, events: [] },
                { id: "webhook-2", type: "webhook", enabled: true, config: {}, events: [] },
            ];
            const duplicates = checkDuplicateIds(integrations);
            expect(duplicates).toHaveLength(0);
        });
        it("detects duplicate IDs", () => {
            const integrations = [
                { id: "webhook-1", type: "webhook", enabled: true, config: {}, events: [] },
                { id: "webhook-1", type: "cli", enabled: true, config: {}, events: [] },
            ];
            const duplicates = checkDuplicateIds(integrations);
            expect(duplicates).toContain("webhook-1");
        });
    });
    describe("sanitizeArgument", () => {
        it("removes null bytes", () => {
            expect(sanitizeArgument("hello\u0000world")).toBe("helloworld");
        });
        it("removes control characters", () => {
            expect(sanitizeArgument("hello\u0001\u0002world")).toBe("helloworld");
        });
        it("preserves common whitespace", () => {
            expect(sanitizeArgument("hello world\t")).toBe("hello world\t");
        });
    });
});
describe("Template Variables", () => {
    describe("getVariablesForEvent", () => {
        it("returns core variables for all events", () => {
            const vars = getVariablesForEvent("session-start");
            expect(vars).toContain("sessionId");
            expect(vars).toContain("projectName");
            expect(vars).toContain("timestamp");
            expect(vars).toContain("event");
        });
        it("returns session-end specific variables", () => {
            const vars = getVariablesForEvent("session-end");
            expect(vars).toContain("duration");
            expect(vars).toContain("durationMs");
            expect(vars).toContain("agentsSpawned");
            expect(vars).toContain("agentsCompleted");
        });
        it("does not return session-end variables for session-start", () => {
            const vars = getVariablesForEvent("session-start");
            expect(vars).not.toContain("duration");
            expect(vars).not.toContain("agentsSpawned");
        });
        it("returns question variable for ask-user-question", () => {
            const vars = getVariablesForEvent("ask-user-question");
            expect(vars).toContain("question");
        });
    });
});
describe("Presets", () => {
    describe("CUSTOM_INTEGRATION_PRESETS", () => {
        it("contains openclaw preset", () => {
            expect(CUSTOM_INTEGRATION_PRESETS.openclaw).toBeDefined();
            expect(CUSTOM_INTEGRATION_PRESETS.openclaw.type).toBe("webhook");
            expect(CUSTOM_INTEGRATION_PRESETS.openclaw.defaultConfig.method).toBe("POST");
        });
        it("contains n8n preset", () => {
            expect(CUSTOM_INTEGRATION_PRESETS.n8n).toBeDefined();
            expect(CUSTOM_INTEGRATION_PRESETS.n8n.type).toBe("webhook");
        });
        it("contains clawdbot preset", () => {
            expect(CUSTOM_INTEGRATION_PRESETS.clawdbot).toBeDefined();
            expect(CUSTOM_INTEGRATION_PRESETS.clawdbot.type).toBe("webhook");
        });
        it("contains generic webhook preset", () => {
            expect(CUSTOM_INTEGRATION_PRESETS["generic-webhook"]).toBeDefined();
        });
        it("contains generic CLI preset", () => {
            expect(CUSTOM_INTEGRATION_PRESETS["generic-cli"]).toBeDefined();
            expect(CUSTOM_INTEGRATION_PRESETS["generic-cli"].type).toBe("cli");
        });
    });
    describe("getPreset", () => {
        it("returns preset by name", () => {
            const preset = getPreset("openclaw");
            expect(preset).toBeDefined();
            expect(preset?.name).toBe("OpenClaw Gateway");
        });
        it("returns undefined for unknown preset", () => {
            const preset = getPreset("unknown");
            expect(preset).toBeUndefined();
        });
    });
});
describe("Template Interpolation", () => {
    it("interpolates simple variables", () => {
        const payload = {
            sessionId: "abc123",
            projectName: "my-project",
            event: "session-end",
        };
        const template = "Session {{sessionId}} for {{projectName}} {{event}}";
        const result = interpolateTemplate(template, payload);
        expect(result).toBe("Session abc123 for my-project session-end");
    });
    it("replaces unknown variables with empty string", () => {
        const payload = {
            sessionId: "abc123",
        };
        const template = "Session {{sessionId}} unknown {{unknownVar}}";
        const result = interpolateTemplate(template, payload);
        // Unknown variables are replaced with empty string
        expect(result).toBe("Session abc123 unknown");
    });
    it("handles empty payload by replacing all variables with empty strings", () => {
        const template = "Session {{sessionId}}";
        const result = interpolateTemplate(template, {});
        // All variables replaced with empty strings
        expect(result).toBe("Session");
    });
});
//# sourceMappingURL=custom-integration.test.js.map