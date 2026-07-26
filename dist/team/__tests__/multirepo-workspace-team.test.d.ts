/**
 * Regression: team runtime writes must not false-positive "Path traversal
 * detected" in a multi-repo .omc-workspace layout.
 *
 * In that layout the shared .omc root lives at the workspace anchor (the parent
 * of each sub-repo), so paths built with getOmcRoot(subRepo) resolve ABOVE the
 * sub-repo. Validation that used the sub-repo as the allowed base threw and
 * dropped team metadata / audit / usage / restart / worktree state.
 *
 * Setup mirrors the reviewer's reproduction: parent/.omc-workspace + parent/api.
 */
export {};
//# sourceMappingURL=multirepo-workspace-team.test.d.ts.map