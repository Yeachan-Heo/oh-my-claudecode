import * as path from "path";
import { OmcPaths, validateWorkingDirectory, } from "../../lib/worktree-paths.js";
import { getGlobalOmcStateRoot } from "../../utils/paths.js";
/** Get the absolute local state directory for the current worktree. */
export function getLocalStateDir() {
    return path.join(validateWorkingDirectory(), OmcPaths.STATE);
}
/**
 * @deprecated for mode state. Global state is only used for analytics and daemon state.
 * Mode state should use LOCAL_STATE_DIR exclusively.
 */
export const GLOBAL_STATE_DIR = getGlobalOmcStateRoot();
//# sourceMappingURL=state-paths.js.map