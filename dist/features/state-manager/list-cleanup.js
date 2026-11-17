import * as fs from "fs";
import * as path from "path";
import { GLOBAL_STATE_DIR, getLocalStateDir } from "./state-paths.js";
import { StateLocation, } from "./types.js";
/**
 * Compile a simple glob (`*` matches anything) into an anchored RegExp.
 * Every other character is matched literally, so names like `a.b` and
 * `state(1)` do not match unintended names or create invalid regexes.
 */
function globToRegExp(pattern) {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp("^" + source + "$");
}
/**
 * List all state files
 *
 * Returns information about all state files in the specified location(s).
 */
export function listStates(options) {
    const results = [];
    const includeLegacy = options?.includeLegacy ?? false;
    const pattern = options?.pattern;
    // Helper to check whether a state name matches the requested pattern.
    const matchesPattern = (name) => {
        if (!pattern)
            return true;
        return globToRegExp(pattern).test(name);
    };
    // Helper to add state files from one directory.
    const addStatesFromDir = (dir, location, isLegacy = false) => {
        if (!fs.existsSync(dir))
            return;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (!file.endsWith(".json"))
                    continue;
                const name = file.slice(0, -5); // Remove .json
                if (!matchesPattern(name))
                    continue;
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);
                results.push({
                    name,
                    path: filePath,
                    location,
                    size: stats.size,
                    modified: stats.mtime,
                    isLegacy,
                });
            }
        }
        catch (error) {
            console.warn(`Failed to list states from ${dir}:`, error);
        }
    };
    // Check standard locations.
    if (!options?.location || options.location === StateLocation.LOCAL) {
        addStatesFromDir(getLocalStateDir(), StateLocation.LOCAL);
    }
    if (!options?.location || options.location === StateLocation.GLOBAL) {
        addStatesFromDir(GLOBAL_STATE_DIR, StateLocation.GLOBAL);
    }
    // Check legacy locations if requested.
    if (includeLegacy) {
        // Legacy locations are name-specific; there is no complete directory to scan.
    }
    return results;
}
/**
 * Cleanup orphaned state files
 *
 * Removes state files that haven't been modified in a long time.
 * Useful for cleaning up abandoned states.
 */
export function cleanupOrphanedStates(options) {
    const maxAgeDays = options?.maxAgeDays ?? 30;
    const dryRun = options?.dryRun ?? false;
    const exclude = options?.exclude ?? [];
    const result = {
        deleted: [],
        wouldDelete: dryRun ? [] : undefined,
        spaceFreed: 0,
        errors: [],
    };
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    const states = listStates({ includeLegacy: false });
    for (const state of states) {
        // Skip excluded patterns.
        if (exclude.some((pattern) => globToRegExp(pattern).test(state.name))) {
            continue;
        }
        // Check if old enough.
        if (state.modified > cutoffDate) {
            continue;
        }
        // Delete or record for dry run.
        if (dryRun) {
            result.wouldDelete?.push(state.path);
            result.spaceFreed += state.size;
        }
        else {
            try {
                fs.unlinkSync(state.path);
                result.deleted.push(state.path);
                result.spaceFreed += state.size;
            }
            catch (error) {
                result.errors.push({
                    path: state.path,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return result;
}
//# sourceMappingURL=list-cleanup.js.map