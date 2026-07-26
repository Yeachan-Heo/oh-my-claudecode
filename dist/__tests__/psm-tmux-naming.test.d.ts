/**
 * Regression tests for issue #3528:
 * PSM built tmux session names containing colons (`psm:<alias>:<type>-<id>`).
 * tmux reserves ':' and '.' for its `session:window.pane` target syntax and
 * silently rewrites them, so every later has-session / send-keys / list /
 * attach / kill / cleanup and registry lookup missed and sessions were orphaned.
 *
 * The fix introduces ONE canonical tmux-safe naming contract
 * (psm_tmux_safe_name + psm_tmux_name_from_id) applied at every tmux boundary,
 * plus a fail-closed post-create assertion. These tests cover the contract,
 * create, lookup, registration, list, attach, kill/cleanup, status reverse
 * lookup, and the source/docs contract.
 */
export {};
//# sourceMappingURL=psm-tmux-naming.test.d.ts.map