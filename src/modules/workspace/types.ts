/**
 * Types for the Workspace module
 */

// ============================================================================
// Mount Configuration
// ============================================================================

/**
 * Configuration for a single filesystem mount.
 */
export interface MountConfig {
  /** Mount name — becomes the path prefix (e.g., "project", "config") */
  name: string;
  /** Absolute filesystem path to mount */
  path: string;
  /** Access mode */
  mode: 'read-write' | 'read-only';
  /**
   * Watch mode for filesystem changes:
   * - 'always': chokidar watches continuously; each event re-observes its paths
   * - 'on-agent-action': after each completed agent tool batch, the mount is
   *   scanned, and the agent's next inference waits for that scan up to
   *   `agentActionScanDeadlineMs`; a scan that takes longer finishes while
   *   the round goes on. Each scan walks from the mount's start, so on a
   *   mount over its `walkCap` it covers the first `walkCap` entries every
   *   time, and files past them come in as `walkCap` describes
   * - 'never': no background reads; listings and lazy reads still observe
   *   the paths they show
   */
  watch?: 'always' | 'on-agent-action' | 'never';
  /** Debounce window in ms for watch: 'always' mode (default: 300) */
  watchDebounceMs?: number;
  /** Poll interval in ms for checking watched root identity changes (default: 2000) */
  watchRootPollMs?: number;
  /**
   * Simple ignore patterns (NOT full gitignore syntax). Supported forms:
   * - Exact name match: ".git", "node_modules"
   * - Directory glob: "node_modules/**" (anything under node_modules)
   * - Extension glob: "*.pyc" (any file ending in .pyc)
   * A sync without a path and the watcher pass over what the list covers,
   * and over entries with an editor's swap or backup file name whatever it
   * says, a directory with what lies beneath it: `.name.swp` and `.name.swx`
   * (the whole name), and names ending in `~` or in `.subl…tmp`, matched by
   * `^\..+\.sw[px]$`, `~$` and `\.subl.*\.tmp$`.
   */
  ignore?: string[];
  /**
   * The files this mount holds, when it holds only some of what is under its
   * path: the same pattern forms as `ignore`, read for files. A name or an
   * extension glob covers a file by its own name, at any depth, and a directory
   * glob (`dir/**`) covers what lies beneath that directory, and not a file
   * named like it. Unlike `ignore`, a pattern that matches a directory's name
   * covers nothing beneath it, since each file is covered by its own name:
   * `["gate.json"]` holds every file named `gate.json`, and no other file
   * beneath a directory of that name. A subtree is named with `dir/**`. It's
   * the mount's boundary. A file or link it doesn't cover is outside the mount:
   * a walk passes over it, a change the watcher reports there is dropped, and a
   * materialize doesn't write it back even when the workspace's history holds
   * it. A materialize that names a directory inside the mount counts each such
   * entry beneath it under `passedOver`, with the reason and without its path,
   * a deletion or conflict held there included; one of the whole mount takes
   * none of them up. No tool names a file the include doesn't cover, beyond
   * echoing a path it was given. Every tool refuses a path with a `..` segment
   * on such a mount, whatever it reaches, before it looks the path up (text the
   * host registers aside, below), and the refusal says to give the path from
   * the mount's root with no `..` in it. The file operations (read, write,
   * edit, delete, and the module's binary and disk reads and writes) refuse any
   * path it doesn't cover as outside the mount's include, a directory's
   * included, and `resolveAbsolutePath` returns null for one; the mount's root
   * is inside when it's named without a `..`. Directories are walked unless
   * `ignore` covers them, and no link the walk meets is walked, so a listing
   * that isn't recursive names each directory directly beneath its path that
   * disk has, whether or not anything beneath it is covered, and each that a
   * covered entry in the workspace's history implies; the files it shows are
   * only those the include covers. A sync, materialize, grep, glob or ls that
   * names a path the include doesn't cover takes it as a directory, its scope,
   * exactly where a listing names one: where disk has a directory reached from
   * the mount's root through directories, with no link among them, or the
   * workspace's history holds an entry beneath it that the include covers. The
   * one exception is a directory `ignore` covers, which a listing passes over
   * and which is still a scope when it's named. It refuses any other path the
   * include doesn't cover the same way, so a name outside the include gets the
   * same answer whether a file is there, on disk or in history, or not. Where
   * covered history makes a name a scope and disk has since put a link there, a
   * mount that doesn't follow symlinks refuses the link, as it refuses any link
   * on a path's way, and on a mount that does, a pass of that scope follows the
   * link, so its answer shows whether the link leads out of the mount. A
   * covered path is a file to a sync, materialize or grep when disk or history
   * has a file there, and otherwise a directory; a glob takes its path as a
   * directory. Beneath a directory, each passes over what the include doesn't
   * cover. `ignore` still applies to what `include` covers. On a disk that
   * folds names, a path is judged as disk spells it, as the walk judges what it
   * lists, so a covered name whose file disk spells otherwise is outside the
   * mount, and a refusal shows the path as given. `resolveAbsolutePath`, which
   * is synchronous, judges the include on the path as given: on such a disk it
   * returns the path to a covered name's file that disk spells otherwise, and
   * null for a covered file named in another case. It takes a nested mount's
   * directory as that mount's in any spelling disk folds to it, compared level
   * by level as each directory on the way compares names. Where it can't tell,
   * it errs toward the nested mount: a level it can't tell at start, as for a
   * nested directory not yet on disk, is taken to fold, and it compares case
   * loosely too, so it also takes a spelling a disk may keep apart, such as
   * `strasse` for a nested `straße`. It names paths: on a mount that follows
   * symlinks, a link among a covered path's parent directories is followed, and
   * a link it covers is read and written through its own name, wherever the
   * link leads inside the mount. On one that doesn't, a link on a path's way is
   * refused, as on any such mount, and the refusal names an inside target only
   * where a tool could name it: a directory, or a file the include covers, and
   * in a nested mount's directory, a directory or a file that mount's own
   * include covers. A path in a nested mount's directory is that mount's,
   * whatever this include covers: every tool gives the answer that names the
   * mount holding it, with the rest of the path past that mount's directory as
   * given. A path with a `..` segment is refused before that, as above. Text
   * the host registers for a path (`registerGeneratedTextFile`) is served there
   * whatever the include says, since it isn't one of the mount's files: it's
   * matched by the path a spelling resolves to, before anything else checks the
   * path, so every spelling that resolves to its registered path reads it, a
   * `..` one included, and none writes it. On a disk that folds names, a
   * spelling in another case isn't its path, and reaches whatever file disk has
   * there. The framework keeps its own files (`tool-results/`, `refs/`,
   * `background-scripts/`) only in a writable mount without an include, and
   * what it kept in a mount before the mount had one is outside the mount once
   * it has one, unless the include covers it. Left out, the mount holds
   * everything under its path. Given, it's a list of at least one string, each
   * a name, an `*.ext` glob or a `dir/**` glob, whose directory may be nested
   * (`a/b/**`). The module refuses a pattern with a `/` that isn't such a glob,
   * a `*` anywhere but a leading `*.` or that trailing `/**`, and an empty, `.`
   * or `..` segment. Any other pattern is a file name, matched literally, so
   * `[id].tsx` names the file of that name.
   */
  include?: string[];
  /**
   * Whether to follow symlinks (default: false). Without it, no symlink on a
   * path is followed: not one at the path itself, and not one among the
   * directories on its way beneath the mount's root, wherever it leads. A path
   * with a symlink among its directories is refused naming the link, and for
   * a link inside the mount, its target. A mount root that is
   * itself a symlink is still the root. With it, a symlink on a path is
   * followed while what it reaches stays inside the mount. Either way, a
   * listing or a sync's walk descends into no symlinked directory.
   */
  followSymlinks?: boolean;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
  /**
   * The most entries one walk of this mount takes (default: 5000), a
   * positive integer no larger than Number.MAX_SAFE_INTEGER: files, and
   * links or other entries that aren't
   * directories, each of which the pass observes. A sync that reaches it
   * reports the rest as incomplete, and the next sync of the same scope
   * resumes after the last entry it took, wrapping to the start, so repeated
   * syncs cover a larger mount. A watched mount's catch-up scan (at start,
   * and when its watcher reattaches) takes its turn in the same rotation as
   * the mount's bare syncs, so on a mount over the cap, a change made while
   * the process was down waits for the rotation to reach it. The place is
   * kept with the mount's disk evidence, so a restart resumes there, unless
   * the machine went down before the store made the latest place durable.
   * An agent-action scan (`watch: 'on-agent-action'`) and a listing (`ls`,
   * `glob`, `grep`) take up to it from their scope's start every time:
   * `glob`'s is the directory its pattern's segments before the first
   * wildcard name beneath its `path`, and `grep`'s the deeper of its `path`
   * and its `glob` filter's directory, as far as disk lists each segment
   * with that spelling as a directory, not a link. Each directory's listing
   * is read whole, so a deletion is seen wherever the walk lists, whatever
   * it took.
   *
   * It bounds what a walk observes, not the walk's own work: directories
   * don't count against it, and each one the walk visits is read whole, so
   * a tree of many directories that hold nothing is walked in full.
   */
  walkCap?: number;
  /**
   * If set, filesystem changes on this mount request inference.
   * - `true` — wake on any op (created | modified | deleted)
   * - array — wake only for the listed ops
   *
   * Self-writes through the module's own tools are already suppressed by the
   * watcher, so a mount shared between agents only wakes on external writes.
   * A change of a file's mode alone is recorded, and makes no event: it
   * brings nothing new to read.
   * The EventGate still has final say — use gate policies for path-glob
   * filtering or to disable wake temporarily via hot-reload.
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;

  /**
   * If true, writes/edits/deletes via the module's tools materialize to the
   * filesystem immediately (not just into Chronicle tree state). Required for
   * any mount shared across agents as a communication channel — without it,
   * another agent's watcher on the same directory sees nothing. The watcher
   * suppresses its own echoes, so this doesn't cause self-wake loops.
   */
  autoMaterialize?: boolean;
}

/**
 * Configuration for the WorkspaceModule.
 */
export interface WorkspaceConfig {
  /** Mount configurations */
  mounts: MountConfig[];
  /** Only materialize the active branch to filesystem (default: true) */
  materializeOnlyActiveBranch?: boolean;
  /** Delta snapshot frequency for tree states (default: 50) */
  deltaSnapshotEvery?: number;
  /** Full snapshot frequency for tree states (default: 10) */
  fullSnapshotEvery?: number;
  /**
   * How long the scan of `watch: 'on-agent-action'` mounts after a tool batch
   * may hold the agent's next inference, in ms (default: 20000). A scan that
   * takes longer finishes in the background; the miss is recorded on the
   * mount's status and pushed as a `workspace:agent-action-scan-incomplete`
   * event. So is a scan that finished without observing everything, with the
   * regions it couldn't (`incomplete`). While a scan that outlasted its
   * deadline still runs, later batches aren't held: their scan is queued
   * after it, and the miss is recorded at once. The framework bounds every
   * module's batch hook at 30 s, so a deadline above 29 s is lowered to 29 s,
   * with a warning, for the workspace's own miss to come first.
   */
  agentActionScanDeadlineMs?: number;
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Per-mount runtime state (not persisted — rebuilt on start). What disk last
 * agreed with lives in the module's disk-agreement journal (global chronicle
 * records), and branch-local intent in `intentTreeStateId`.
 */
export interface MountState {
  /** The mount config */
  config: MountConfig;
  /** Tree state ID in Chronicle */
  treeStateId: string;
  /** Branch-local intent (tombstones, store origin, conflicts) for this mount's paths */
  intentTreeStateId: string;
  /** Sequence number of last materialization */
  lastMaterializedSeq: number;
  /** Paths currently suppressed from watcher (recently materialized) */
  suppressedPaths: Set<string>;
  /**
   * Whether a pass over the whole mount has run this session. On a mount
   * over its walkCap, that pass took the first walkCap entries.
   */
  initialSyncDone: boolean;
  /** Branch ID that was active when this mount last materialized */
  lastMaterializedBranchId: string | null;
  /**
   * The last on-agent-action scan, as of `at`: `complete` when it has
   * finished at all, `withinDeadline` when it finished before the deadline
   * released the round, `reason` for a miss or a failure, and `incomplete`
   * for the regions a finished scan couldn't observe (each also pushed as a
   * `workspace:agent-action-scan-incomplete` event).
   */
  lastAgentActionScan?: {
    at: number;
    complete: boolean;
    withinDeadline: boolean;
    reason?: string;
    incomplete?: Array<{ path: string; reason: string }>;
  };
  /**
   * The after-batch scan queued behind the mount's running work, not yet
   * started: later batches share it, since it starts after their tools ran.
   */
  agentActionScanWaiting?: AgentActionScan;
  /**
   * The mount's newest after-batch scan. Only its outcome is put on
   * `lastAgentActionScan`: one queued behind an older scan describes a later
   * batch, which the older scan's outcome mustn't speak for.
   */
  agentActionScanLatest?: AgentActionScan;
  /** A scan that outlasted a batch's deadline, while it still runs. */
  agentActionScanLate?: Promise<unknown>;
  /**
   * Wall-clock time chokidar emitted `ready` for this mount, or null if the
   * watcher hasn't finished its initial scan. null after session start =
   * watcher attach silently failed; a set value with empty tree = attached
   * to an empty directory.
   */
  watcherReadyAt: number | null;
  /** Most recent chokidar error for this mount, if any. */
  watcherError: string | null;
}

/**
 * Persisted module state (via Chronicle snapshot).
 */
export interface WorkspaceModuleState {
  /** Per-mount metadata */
  mounts: Record<string, {
    lastMaterializedSeq: number;
    lastMaterializedBranchId?: string;
    watcherReadyAt?: number | null;
    watcherError?: string | null;
  }>;
  /** Branch ID considered "active" for materialization */
  activeBranchId?: string;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface ReadInput {
  /** File path (mount-prefixed, e.g., "project/src/main.ts") */
  path: string;
  /** Starting line (1-indexed, optional) */
  offset?: number;
  /** Number of lines to read (optional) */
  limit?: number;
  /** Zero-based UTF-16 offset; selects character paging. Cannot mix with line offset/limit. */
  offsetChars?: number;
  /** Character page size in UTF-16 code units (default 2000); selects character paging.
   * May include one extra code unit to keep a surrogate pair intact. */
  limitChars?: number;
}

export interface ReadImageInput {
  /** Image file path (mount-prefixed, e.g., "project/assets/logo.png") */
  path: string;
}

export interface WriteInput {
  /** File path (mount-prefixed) */
  path: string;
  /** Content to write */
  content: string;
}

export interface EditInput {
  /** File path (mount-prefixed) */
  path: string;
  /** String to find */
  oldString: string;
  /** String to replace with */
  newString: string;
  /** Replace all occurrences (default: false) */
  replaceAll?: boolean;
}

export interface DeleteInput {
  /** File path (mount-prefixed) */
  path: string;
}

export interface LsInput {
  /** Directory path (mount-prefixed, optional — defaults to workspace root) */
  path?: string;
  /** List recursively (default: false) */
  recursive?: boolean;
}

export interface GlobInput {
  /** Glob pattern */
  pattern: string;
  /** Directory to search in (mount-prefixed, optional) */
  path?: string;
}

export interface GrepInput {
  /** Regex pattern */
  pattern: string;
  /** File or directory to search in (mount-prefixed, optional) */
  path?: string;
  /** Glob pattern to filter files */
  glob?: string;
  /** Context lines before match */
  contextBefore?: number;
  /** Context lines after match */
  contextAfter?: number;
}

/** One after-batch scan of a mount, shared by the batches that wait for it. */
export interface AgentActionScan {
  /** Whether some batch stopped waiting for it (its deadline passed, or an earlier scan still ran late). */
  late: boolean;
  /** Settles, never rejects, once its outcome is recorded: on status if it is the newest, as events either way. */
  settled: Promise<void>;
}

export interface StatusInput {
  /** Specific mount to check (optional — defaults to all) */
  mount?: string;
}

export interface MaterializeInput {
  /** Specific file or directory path to materialize (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all read-write mounts) */
  mount?: string;
  /**
   * Materialize even when the current branch has genuinely diverged from the
   * branch last materialized to disk, and overwrite a disk copy in conflict
   * (default: false). Not needed for linear continuations (child branches
   * forked at or after the last materialized point) — those pass the guard
   * automatically.
   */
  force?: boolean;
  /**
   * Also delete from disk the files deleted in the workspace whose disk copy
   * is still one the workspace holds (default: false). With `force`, also
   * those whose disk copy changed since.
   */
  applyDeletions?: boolean;
}

export interface SyncInput {
  /** Specific file or directory path to sync (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all) */
  mount?: string;
  /** Take each mount's root as it is now, when it isn't the directory disk last agreed with. */
  acceptRoot?: boolean;
}

// ============================================================================
// Events
// ============================================================================

export type WorkspaceFsOp = 'created' | 'modified' | 'deleted';

/**
 * Fired when files in a mount are created. `paths` are mount-prefixed
 * (e.g. "tickets/2026-04-20-foo.md"). Conflicts are reported when Chronicle
 * sync detected divergence between the filesystem and the tree state.
 */
export interface WorkspaceCreatedEvent {
  type: 'workspace:created';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceModifiedEvent {
  type: 'workspace:modified';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceDeletedEvent {
  type: 'workspace:deleted';
  paths: string[];
  mount: string;
  /** Paths deleted on disk whose newer workspace version was kept as a conflict. */
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceMountedEvent {
  type: 'workspace:mounted';
  mount: string;
  path: string;
  [key: string]: unknown;
}

export interface WorkspaceUnmountedEvent {
  type: 'workspace:unmounted';
  mount: string;
  [key: string]: unknown;
}

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | WorkspaceModifiedEvent
  | WorkspaceDeletedEvent
  | WorkspaceMountedEvent
  | WorkspaceUnmountedEvent;

export const WORKSPACE_FS_EVENT_TYPES = [
  'workspace:created',
  'workspace:modified',
  'workspace:deleted',
] as const;

export type WorkspaceFsEventType = typeof WORKSPACE_FS_EVENT_TYPES[number];

export function opToEventType(op: WorkspaceFsOp): WorkspaceFsEventType {
  return `workspace:${op}` as WorkspaceFsEventType;
}
