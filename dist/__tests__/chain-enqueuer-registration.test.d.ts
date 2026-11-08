/**
 * Tests for the SessionEnd chain-enqueuer hook registration (software factory
 * third link): the omc-setup installer must register the SessionEnd hook that
 * forwards to the OMC bridge (--hook=session-end → planChainEnqueue), and the
 * registration must be idempotent (no duplicate writes on repeat installs).
 *
 * Tests exercise the real installer code path: getHooksSettingsConfig() for
 * the desired config and mergeHookGroups() for the settings.json merge.
 */
export {};
//# sourceMappingURL=chain-enqueuer-registration.test.d.ts.map