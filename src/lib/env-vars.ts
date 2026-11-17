/** Env var set by omc CLI when --plugin-dir is passed; read by HUD wrapper and setup auto-detect. */
export const OMC_PLUGIN_ROOT_ENV = "OMC_PLUGIN_ROOT";

/** Env var set by the HUD wrapper when it skips a newer cached plugin version that has no built HUD; read by the HUD it loads instead. */
export const OMC_HUD_UNBUILT_VERSION_ENV = "OMC_HUD_UNBUILT_VERSION";
