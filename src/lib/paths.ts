/**
 * Canonical OMC path conventions — single source of truth.
 * These strings also appear in scripts/lib/hud-wrapper-template.txt and
 * scripts/plugin-setup.mjs; keep them in sync (enforced by paths-consistency.test.ts).
 */
export const OMC_PLUGIN_MARKETPLACE_SLUG = "omc";
export const OMC_PLUGIN_PACKAGE_NAME = "oh-my-claudecode";
export const OMC_PLUGIN_CACHE_REL = `plugins/cache/${OMC_PLUGIN_MARKETPLACE_SLUG}/${OMC_PLUGIN_PACKAGE_NAME}`;
export const OMC_PLUGIN_MARKETPLACE_REL = `plugins/marketplaces/${OMC_PLUGIN_MARKETPLACE_SLUG}`;
export const OMC_HUD_DIST_REL = "dist/hud/index.js";
export const OMC_HUD_WRAPPER_REL = "hud/omc-hud.mjs";
export const OMC_HUD_WRAPPER_LIB_REL = "hud/lib/config-dir.mjs";
export const OMC_CONFIG_FILE_REL = ".omc-config.json";
