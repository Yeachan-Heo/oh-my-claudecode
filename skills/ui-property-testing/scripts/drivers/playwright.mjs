// Playwright driver for ui-property-testing. Requires playwright (and at
// least one installed browser) in the environment running the explorer.
//
// Driver contract (see scripts/explore.mjs):
//   launch(options) -> { goto, snapshot, apply, settle, facade, close }.
// The snapshot is JSON-serializable: extractors read it in the runner, and
// custom actions receive a facade whose methods map onto this instance.
//
// Default properties travel through the snapshot: uncaught exceptions,
// console errors, and failed HTTP responses are collected and reported by
// the runner's defaults check.

import { chromium } from "playwright";

export const meta = { name: "playwright" };

export async function launch(options = {}) {
  const headless = options.headless ?? true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const failedResponses = [];
  const uncaught = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => uncaught.push(String(error)));

  const instance = {
    async goto(target) {
      await page.goto(target, { waitUntil: "load" });
    },
    async snapshot() {
      /* eslint-disable no-undef -- location, document are browser globals available in page.evaluate() */
      const browserState = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 4000) ?? "",
        buttons: [...document.querySelectorAll("button, [role=button]")].map(
          (b) => b.textContent?.trim() ?? "",
        ),
        inputs: [...document.querySelectorAll("input, textarea")].map((i) => i.type ?? "text"),
      }));
      /* eslint-enable no-undef */
      return {
        ...browserState,
        consoleErrors: [...consoleErrors],
        failedResponses: [...failedResponses],
        uncaught: [...uncaught],
      };
    },
    async apply(action) {
      switch (action.action) {
        case "click":
          await page.click(action.selector);
          break;
        case "fill":
          await page.fill(action.selector, String(action.value));
          break;
        case "press":
          await page.keyboard.press(action.key);
          break;
        case "navigate":
          await page.goto(action.target, { waitUntil: "load" });
          break;
        case "wait":
          await page.waitForTimeout(action.ms);
          break;
        case "custom":
          throw new Error(
            `custom action "${action.name}" must run through the runner's facade, not the driver directly`,
          );
        default:
          throw new Error(`unknown action type: ${action.action}`);
      }
    },
    // The facade custom-action fns receive; maps spec intent onto the page.
    facade: {
      click: async (selector) => page.click(selector),
      fill: async (selector, value) => page.fill(selector, String(value)),
      press: async (key) => page.keyboard.press(key),
      navigate: async (target) => page.goto(target),
      wait: async (ms) => page.waitForTimeout(ms),
      snapshot: () => instance.snapshot(),
    },
    async settle() {
      try {
        await page.waitForLoadState("networkidle", { timeout: 2000 });
      } catch {
        // Busy surfaces never settle — the next snapshot is taken anyway.
      }
    },
    async close() {
      await browser.close();
    },
  };
  return instance;
}
