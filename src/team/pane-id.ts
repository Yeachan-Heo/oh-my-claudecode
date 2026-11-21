/** Herdr pane ids look like `wN:pM` (workspace-qualified, never `%N`). */
export function isHerdrPaneId(value: string | undefined): boolean {
  return (
    typeof value === "string" && /^w[0-9a-z]+:p[0-9a-z]+$/i.test(value.trim())
  );
}
