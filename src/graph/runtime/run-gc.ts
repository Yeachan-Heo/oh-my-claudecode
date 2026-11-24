/**
 * Retention and torn-journal repair for graph run directories, for `omc graph gc`.
 *
 * Removes old run directories under the graph runs root (default `.omc/graph-runs`,
 * the runs root of `omc graph run`). On request it also moves a torn last journal
 * line aside. The command is offline housekeeping: it changes nothing in the
 * runtime and is not wired into any hook. Run it by hand or from a schedule.
 *
 * Switch: nothing is deleted or repaired unless OMC_GRAPH_GC is exactly "1".
 * Without it the command reports WOULD-DELETE and WOULD-REPAIR and writes nothing.
 * A repair also needs --repair-torn-wal or OMC_GRAPH_REPAIR_TORN_WAL="1".
 *
 * Modules: run-gc-read (lease, reads of a run, the verdict), run-gc-scan (configuration and the scan), run-gc-owner
 * (ownership and the open run directory), run-gc-remove (quarantine and deletion), run-gc-repair (torn journal
 * line), run-gc-pass (one pass), run-gc-cli (report and exit codes). This file only names them and carries the rules
 * below, which hold for all of them.
 *
 * Configuration, highest precedence first:
 *   runs root        --runs-root <dir>            | OMC_GRAPH_RUNS_ROOT            | .omc/graph-runs (relative to cwd)
 *   retention days   --retention-days <N>         | OMC_GRAPH_RETENTION_DAYS       | 7 (positive integer only)
 *   repair torn WAL  --repair-torn-wal            | OMC_GRAPH_REPAIR_TORN_WAL="1"  | off
 *
 * Run state, derived from the files on disk (the runtime stores no status field). It is derived the way the runtime
 * derives it, by the function `omc graph status` uses (classifyRunFiles in run-state.ts): the journal is replayed with
 * the runtime's replay fold (descriptor binding, epochs, envelope and request fingerprints, scheduler transitions) and
 * projection.json is only a status cache, never trusted for the verdict. Under ownership the replay is bounded by the
 * epoch the lock gave, which is the bound a resume applies.
 *   final-succeeded      the scheduler success predicate holds after the replay
 *   final-failed         no activation can run after the replay, and the run did not succeed
 *   resumable-approval   a human-approval activation is ready
 *   resumable-ready      an activation is ready to start (an attempt that was running when the process stopped was
 *                        never committed, so it is ready again after the replay)
 *   unknown:<reason>     anything else (no descriptor, a descriptor of another run, a journal that is corrupt or fails
 *                        the replay, a descriptor with neither a record nor the initial snapshot); the run is kept
 * Only the two final states can be deleted, and only after the retention window. The runtime has no separate
 * "cancelled" state: an aborted run keeps its ready activations and stays resumable. Any doubt keeps the run.
 *
 * Safety rules:
 *   - The runs root must be named `.omc/graph-runs`. A symbolic link at the runs root is refused.
 *   - Only real directories whose names match the run id pattern are candidates.
 *   - A run is kept when it is the --current run; when its owner.lock names a live process or
 *     cannot be read (fail closed); when its journal ends in a torn line; when a torn copy from an
 *     earlier repair is still present; when it is fresh (an entry below it changed inside the
 *     retention window); or when its state is not final. An owner.lock whose pid is dead does not
 *     protect a run.
 *   - A torn last journal line is copied to `journal.jsonl.torn-<stamp>` before the journal is
 *     shortened (the complete lines go to a new file that is renamed over the journal, so the checked inode is never
 *     modified). This command never deletes such a copy: a run that holds one is kept.
 *   - Removal takes ownership of the run first, through the same single-writer fence the runtime uses: a run that is
 *     owned, or whose ownership cannot be taken, is not removed. The scan records the identity (device and inode) of
 *     every run directory. Removal opens the directory without following a link and refuses it when it is not the
 *     scanned one, so a run replaced by a new run with the same id after the scan is never deleted on the verdict of
 *     the old one. Under the lock it decides the run again by the same rules as the scan (a resume that finished
 *     after the scan makes the run fresh again), then moves the run directory under
 *     the runs root (an atomic rename, so no process can resume the run from then on), checks that the moved directory is
 *     the scanned one, renames it to `.deleted-<run id>-<time>-<random>-<dev>-<ino>` (the identity of the checked directory) and deletes it. A directory left behind by an interrupted removal is finished by
 *     the next pass, unless the lock inside it still names a live process or it is not the directory whose identity its
 *     name carries (a name without that evidence says nothing about what is under it).
 *   - Under ownership every file of the run is reached through the open run directory, whose identity is the scanned
 *     one (withRunDirectory): the decision reads (the age of the run and its state), the journal and torn copy of a
 *     repair, and the directory sync. The name of the run is checked again before the copy, before the shortened journal is put in place and
 *     after the decision reads; a name that was swapped refuses the step. A directory can only be renamed by name, so
 *     the name is checked right before the move and the moved directory right after it, and a directory that is not
 *     the scanned one is put back; when the name is taken again and it cannot be put back, it stays under
 *     its staging name `.moving-<run id>-<time>-<random>`. The moved directory waits under the staging name, which no
 *     pass deletes, until it is known to be the scanned one; only then is it renamed to `.deleted-...`, so a process
 *     that ends after the move leaves nothing that the next pass would delete unchecked.
 *   - The platform is never told by its name: every platform that has directory-relative operations (the runtime's
 *     contained filesystem layer: Linux, and macOS with the native module) makes all of those decisions and the
 *     removal through them. A platform that has none cannot take ownership (the fence needs the same operations), and
 *     gc and repair refuse before anything is read: a decision that deletes is never made on reads by name that are
 *     only checked before and after, because a name swapped and swapped back in between would pass both checks. The
 *     scan, which runs before ownership, reads by name; its verdict is only a hint and is decided again under the lock.
 *   - Removal never follows a symbolic link: a link is unlinked, its target is left alone. Every directory is opened
 *     without following links, checked to be the one that was seen, and its entries are removed relative to that open
 *     directory, so a directory swapped for a link while the tree is walked cannot redirect the removal. The top directory is
 *     opened and finally removed relative to its parent, which is held open. Where the platform's operations have no
 *     `rmdir` (macOS), a tree that has a subdirectory is refused before anything is removed, because removing the
 *     emptied subdirectory by its path would follow a swapped ancestor, and the final rmdir of the top directory is by
 *     name after the held parent is checked; a directory swapped in at that moment is removed only if it is empty, and
 *     rmdir never follows a link.
 *   - An invalid retention value stops the command before anything is touched.
 */

export {
  ConfigError,
  DEFAULT_GC_RUNS_ROOT,
  DEFAULT_RETENTION_DAYS,
  GC_REPAIR_ENV,
  GC_RETENTION_ENV,
  GC_RUNS_ROOT_ENV,
  GC_SWITCH_ENV,
  isSwitchOn,
  parseRetentionDays,
  resolveRunsRoot,
  scanRuns,
  type GcScan,
} from "./run-gc-scan.js";
export {
  classifyRun,
  leaseOf,
  splitTornTail,
  type FileIdentity,
  type LeaseState,
  type OperationsFor,
} from "./run-gc-read.js";
export { quarantineRun, removeRun, removeTree, type ScannedRun } from "./run-gc-remove.js";
export { repairTornTail, type RepairInterlock } from "./run-gc-repair.js";
export { runGc, type GcResult, type GcRunOptions } from "./run-gc-pass.js";
export { formatText, runGraphGc, type GraphGcArgs } from "./run-gc-cli.js";
