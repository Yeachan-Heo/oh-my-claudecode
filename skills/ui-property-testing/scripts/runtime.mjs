// Spec-side scaffolding for ui-property-testing specs. A spec is one ES
// module that imports these helpers and exports only properties and action
// generators; the runner populates the runtime while importing it.
//
// The vocabulary mirrors bombadil's specification language (Antithesis):
// extractors produce stateful cells, properties are temporal statements over
// cells, action generators return the possible actions per state, and custom
// actions are registered functions the driver executes.
//
// Singleton via globalThis: the runner and the spec may load this file
// through different URL spellings (case, symlinks), and they must share one
// runtime — the first import installs it, later imports reuse it.
const installed =
  globalThis.__uiPropertyRuntime ??
  { cells: [], properties: [], generators: [], customActions: new Map() };
globalThis.__uiPropertyRuntime = installed;

export const runtime = installed;

// Windows executable-search hardening: this file is a skills/scripts/*.mjs
// entry in the repo-wide entry-point scan, so it carries the same hardening
// the other entry points have.
import { hardenWindowsExeSearch } from "../../../scripts/lib/windows-search.mjs";
hardenWindowsExeSearch();

// Runs on every captured state; returns JSON-serializable data. The cell is
// stateful — `.current` reads the latest value.
export function extract(fn) {
  const cell = { fn, current: undefined };
  runtime.cells.push(cell);
  return cell;
}

// always(thunk): the thunk must hold in this and every future state.
export function always(thunk) {
  const property = { op: "always", thunk };
  runtime.properties.push(property);
  return property;
}

// eventually(thunk).within(n, unit): the thunk must hold in this or any
// future state within the window.
export function eventually(thunk) {
  const property = {
    op: "eventually",
    thunk,
    withinMs: null,
    within(n, unit = "seconds") {
      const multipliers = { ms: 1, seconds: 1000, second: 1000, s: 1000 };
      property.withinMs = n * (multipliers[unit] ?? 1000);
      return property;
    },
  };
  runtime.properties.push(property);
  return property;
}

// actions(thunk): called on every captured state; returns the array of
// action templates possible in that state.
export function actions(thunk) {
  runtime.generators.push(thunk);
  return thunk;
}

// registerCustomAction(name, fn): fn runs as `(facade, ...args)` where the
// facade exposes click/fill/press/navigate/wait/snapshot on the driver.
// Invoking the returned helper produces an action template the runner
// executes through the driver.
export function registerCustomAction(name, fn) {
  runtime.customActions.set(name, fn);
  return (...args) => ({ action: "custom", name, args });
}

// Built-in action templates.
export const click = (selector) => ({ action: "click", selector });
export const fill = (selector, value) => ({ action: "fill", selector, value });
export const press = (key) => ({ action: "press", key });
export const navigate = (target) => ({ action: "navigate", target });
export const wait = (ms) => ({ action: "wait", ms });
