/**
 * Regression test for issue #3349: state root mis-anchors to a git submodule.
 *
 * When the shell cwd drifts into a git submodule, `git rev-parse --show-toplevel`
 * returns the submodule's own root (a submodule is a complete git repo), so OMC
 * created a stray `.omc/` inside the submodule working tree. The fix climbs to
 * the outermost superproject working tree via `--show-superproject-working-tree`
 * so state anchors to the monorepo root.
 */
export {};
//# sourceMappingURL=submodule-state-anchor.test.d.ts.map