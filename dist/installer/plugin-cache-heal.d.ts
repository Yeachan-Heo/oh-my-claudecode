/**
 * Plugin Cache Healing
 *
 * Best-effort cleanup of orphan standalone skills that shadow their
 * plugin-provided counterparts (#2252).
 *
 * ~/.claude/skills/<name>/ directories left over from a previous standalone
 * `omc setup` cause every OMC slash command to appear twice in Claude Code
 * once the plugin is also installed: once bare, once under the
 * `oh-my-claudecode:` namespace. `omc update` alone never cleaned these up,
 * so any user who ever ran `omc setup` stayed permanently in the duplicate
 * state on every subsequent upgrade.
 *
 * {@link pruneOrphanStandaloneSkills} removes ONLY standalone directories
 * whose SKILL.md content hashes match the plugin's copy — user-authored
 * skills with colliding names (e.g. a personal `plan/SKILL.md`) are
 * provably preserved. Removed directories are first moved into
 * `~/.claude/skills/.omc-trash/<name>.<timestamp>/` so even false positives
 * are recoverable.
 *
 * (Note: the sibling #2348 hook-path healing was landed upstream in #2349,
 * so this module intentionally does NOT walk `hooks/hooks.json`.)
 *
 * The helper is intentionally:
 *   - idempotent (safe to call repeatedly)
 *   - never throwing (best-effort, never blocks an update)
 *   - bounded (only operate on artifacts we can prove are OMC-owned)
 */
export interface PruneOrphanSkillsOptions {
    /** Absolute path to ~/.claude/skills/ (or override for tests). */
    skillsDir: string;
    /** Plugin roots whose skills/<name>/ defines the canonical set. */
    pluginRoots: string[];
    /** Optional logger. */
    log?: (msg: string) => void;
}
export interface PruneOrphanSkillsResult {
    removed: string[];
    preserved: string[];
    errors: string[];
}
/**
 * Build a map of `<directoryName> → set-of-SKILL.md-content-hashes` for every
 * skill the plugin installs. We key on directory name and value on a set of
 * hashes because the same `<name>` may exist in multiple installed plugin
 * versions side by side (e.g. 4.11.0 and 4.11.1) with slightly different
 * SKILL.md content.
 *
 * A standalone skill at `~/.claude/skills/<name>/SKILL.md` is considered an
 * OMC-installed orphan iff its content hash is present in this map.
 */
export declare function buildPluginSkillContentMap(pluginRoots: string[]): Map<string, Set<string>>;
/**
 * Remove orphan standalone skill directories that the plugin now provides
 * under its own namespace. A standalone skill is considered an orphan ONLY
 * when:
 *
 *   1. its directory name appears in the plugin's skills/ tree, AND
 *   2. the standalone SKILL.md content hash is byte-identical to a SKILL.md
 *      provided by an installed plugin version.
 *
 * The content-hash check protects user-authored skills that happen to share
 * a name with a bundled plugin skill (e.g. a user-authored
 * `~/.claude/skills/plan/SKILL.md` will not be removed because its content
 * differs from the plugin's `plan/SKILL.md`).
 *
 * Before removal, the orphan directory is moved to
 * `<skillsDir>/.omc-trash/<name>.<timestamp>/` so even false positives are
 * recoverable. Trash directories are never themselves pruned.
 */
export declare function pruneOrphanStandaloneSkills(options: PruneOrphanSkillsOptions): PruneOrphanSkillsResult;
//# sourceMappingURL=plugin-cache-heal.d.ts.map