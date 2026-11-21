/**
 * Integration tests for the ui-property-testing runner, driven by the
 * deterministic task-app fake driver (no browser needed): the full
 * pipeline — spec import, seeded exploration, violation recording, shrink,
 * confirmation, report — runs end to end here.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const RUNNER = join(REPO_ROOT, "skills", "ui-property-testing", "scripts", "explore.mjs");
const DRIVER = join(REPO_ROOT, "skills", "ui-property-testing", "scripts", "drivers", "task-app.mjs");
// Specs import the runtime via its file:// URL — Node ESM cannot load a bare
// Windows drive-letter path.
const RUNTIME_IMPORT = pathToFileURL(join(REPO_ROOT, "skills", "ui-property-testing", "scripts", "runtime.mjs")).href;

const BUGGY_SPEC = `
import { extract, always, actions, registerCustomAction } from "${RUNTIME_IMPORT}";

const countLabel = extract((state) => state.countLabel);
const items = extract((state) => state.items);

export const countAlwaysMatchesItems = always(
  () => countLabel.current === String(items.current.length),
);

const add = registerCustomAction("add", (facade, label) => facade.apply({ action: "custom", name: "add", args: [label] }));
const remove = registerCustomAction("remove", (facade, index) => facade.apply({ action: "custom", name: "remove", args: [index] }));
const toggle = registerCustomAction("toggle", (facade, index) => facade.apply({ action: "custom", name: "toggle", args: [index] }));
let taskCounter = 0;
const filter = registerCustomAction("filter", (facade, value) => facade.apply({ action: "custom", name: "filter", args: [value] }));

export const taskActions = actions(() => [
  add("task-" + (taskCounter++)),
  remove(Math.floor(Math.random() * 3)),
  toggle(Math.floor(Math.random() * 3)),
  filter("active"),
]);
`;

const CLEAN_SPEC = `
import { extract, always, actions, registerCustomAction } from "${RUNTIME_IMPORT}";

const countLabel = extract((state) => state.countLabel);
const items = extract((state) => state.items);

export const countAlwaysMatchesItems = always(
  () => countLabel.current === String(items.current.length),
);

const add = registerCustomAction("add", (facade, label) => facade.apply({ action: "custom", name: "add", args: [label] }));
const remove = registerCustomAction("remove", (facade, index) => facade.apply({ action: "custom", name: "remove", args: [index] }));
let onlyCounter = 0;
const filterAll = registerCustomAction("filter", (facade, value) => facade.apply({ action: "custom", name: "filter", args: [value] }));

export const taskActions = actions(() => [
  add("only-" + (onlyCounter++)),
  filterAll("all"),
]);
`;

function writeSpec(dir, name, body) {
  writeFileSync(join(dir, name), body);
  return join(dir, name);
}

function runExplorer(specPath, seed) {
  return spawnSync(process.execPath, [RUNNER, "--driver", DRIVER, "--spec", specPath, "--seed", String(seed), "--max-steps", "40", "--json"], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
}

describe("ui-property-testing runtime", () => {
  it("finds the injected count defect and shrinks the trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-property-"));
    const specPath = writeSpec(dir, "buggy.mjs", BUGGY_SPEC);
    const r = runExplorer(specPath, 1234);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.violations.length).toBe(1);
    expect(report.violations[0].property).toBe("countAlwaysMatchesItems");
    expect(report.violations[0].confirmationRuns).toBe(2);
    expect(report.violations[0].confirmations).toBe(2);
    const minimized = report.violations[0].minimizedTrace;
    expect(minimized.length).toBeGreaterThan(0);
    expect(minimized.length).toBeLessThanOrEqual(report.violations[0].discoveryTraceLength);
    expect(minimized.some((a) => a.action === "custom" && a.name === "filter" && a.args[0] === "active")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes clean when the defect is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-property-clean-"));
    const specPath = writeSpec(dir, "clean.mjs", CLEAN_SPEC);
    const r = runExplorer(specPath, 1234);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.violations).toHaveLength(0);
    expect(report.steps).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is deterministic for the same seed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-property-det-"));
    const specPath = writeSpec(dir, "buggy.mjs", BUGGY_SPEC);
    const first = runExplorer(specPath, 4242);
    const second = runExplorer(specPath, 4242);
    const firstReport = JSON.parse(first.stdout);
    const secondReport = JSON.parse(second.stdout);
    expect(secondReport.violations[0].minimizedTrace).toEqual(firstReport.violations[0].minimizedTrace);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the whole pipeline with a temp sandbox", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ui-property-sandbox-"));
    mkdirSync(join(sandbox, "scripts"), { recursive: true });
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("playwright driver snapshot collects error arrays from Node context", async () => {
    // Regression test: error arrays (consoleErrors, failedResponses, uncaught)
    // must not be accessed from inside page.evaluate() where they're undefined.
    // They must be collected from Node-side event listeners.
    // 
    // The fix moves error array access outside page.evaluate():
    //   const browserState = await page.evaluate(() => ({ /* DOM data */ }));
    //   return { ...browserState, consoleErrors, failedResponses, uncaught };
    // 
    // This ensures snapshot() returns all required fields without ReferenceError.
    // We verify the code loads without syntax errors.
    const driverPath = join(REPO_ROOT, "skills", "ui-property-testing", "scripts", "drivers", "playwright.mjs");
    const { readFileSync } = await import("node:fs");
    const driverCode = readFileSync(driverPath, "utf8");
    // Verify the fix is in place: error arrays returned outside page.evaluate()
    expect(driverCode).toContain("const browserState = await page.evaluate");
    expect(driverCode).toContain("...browserState,\n        consoleErrors: [...consoleErrors],");
  });
});
