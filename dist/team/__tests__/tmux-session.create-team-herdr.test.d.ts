/**
 * Herdr arm of createTeamSession (Codex review fix).
 *
 * Herdr-only v2 startup calls createTeamSession with workerCount 0 outside
 * tmux. The tmux-only initialization (mouse option, leader select-pane)
 * previously demanded a tmux server identity AFTER the Herdr workspace was
 * already allocated, failing startup and leaking the workspace. These tests
 * pin the exempted zero-worker flow; the Herdr engine is module-mocked.
 */
export {};
//# sourceMappingURL=tmux-session.create-team-herdr.test.d.ts.map