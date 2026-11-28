// Deterministic fake driver: simulates a small task-list UI in-process, so
// the exploration pipeline (spec loading, seeded exploration, violation
// recording, shrink, confirmation) runs end to end with no browser.
//
// It carries one injected defect, mirroring how a real UI accumulates bugs:
// when a task is removed while the "active" filter is on, the count label
// goes stale (shows one more than the real count). A property comparing the
// displayed count to the item list finds it; shrink reduces the discovery
// trace to the minimal trigger.
//
// Driver contract: launch(options) -> { goto, snapshot, apply, settle,
// facade, close }. `bug` (default true) toggles the injected defect.

export const meta = { name: "task-app" };

export async function launch(options = {}) {
  const bug = options.bug ?? true;
  const state = {
    items: [], // { label, done }
    filter: "all",
    countLabel: "0",
    seed: options.seed ?? 1234,
  };

  function countLabelFor() {
    // The defect: the "active" filter's count skips a decrement.
    const shown = state.filter === "active" ? state.items.filter((i) => !i.done).length : state.items.length;
    return bug && state.filter === "active" && state.items.length > 0
      ? String(shown + 1)
      : String(shown);
  }

  function syncLabel() {
    state.countLabel = countLabelFor();
  }

  const actionsById = {
    add: (label) => {
      state.items.push({ label, done: false });
      syncLabel();
    },
    remove: (index) => {
      state.items.splice(Number(index) % Math.max(state.items.length, 1), 1);
      syncLabel();
    },
    toggle: (index) => {
      const item = state.items[Number(index) % Math.max(state.items.length, 1)];
      if (item) item.done = !item.done;
      syncLabel();
    },
    filter: (value) => {
      state.filter = value === "active" ? "active" : value === "done" ? "done" : "all";
      syncLabel();
    },
  };

  const instance = {
    async goto() {
      state.items = [];
      state.filter = "all";
      syncLabel();
    },
    async snapshot() {
      return {
        title: "Task App",
        items: state.items.map((i) => ({ label: i.label, done: i.done })),
        filter: state.filter,
        countLabel: state.countLabel,
      };
    },
    async apply(action) {
      if (action.action === "custom") {
        const handler = actionsById[action.name];
        if (!handler) throw new Error(`unknown custom action: ${action.name}`);
        handler(...action.args);
        return;
      }
      throw new Error(`task-app only executes custom actions, got: ${action.action}`);
    },
    async settle() {},
    facade: {
      snapshot: async () => instance.snapshot(),
      apply: async (action) => instance.apply(action),
    },
    async close() {},
  };
  return instance;
}
