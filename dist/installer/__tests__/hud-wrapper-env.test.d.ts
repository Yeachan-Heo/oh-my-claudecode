/**
 * Tests for the HUD wrapper's resolution order, with focus on the new
 * `OMC_PLUGIN_ROOT` env-var step (highest priority).
 *
 * Plan: binary-weaving-mountain.
 *
 * Strategy: write the wrapper template (which is the same byte-for-byte string
 * the installer would write to <configDir>/hud/omc-hud.mjs) into a tmp dir,
 * stage a sibling `lib/config-dir.mjs` and a fake `dist/hud/index.js` marker,
 * then spawn `node <tmp>/omc-hud.mjs` with controlled env + stdin and assert
 * which resolution branch fired (via stdout marker).
 */
export {};
//# sourceMappingURL=hud-wrapper-env.test.d.ts.map