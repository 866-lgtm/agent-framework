- A tool result the guard withholds now says where its original is. The
  guard's notice ("Tool result withheld by the guard. The tool has already
  executed.") is followed by the original's place: a workspace file under the
  first writable mount's `tool-results/` (named
  `<date>-withheld-<batch>-<index>-<toolUseId>`, one per result, with any
  character outside `A-Za-z0-9._-` replaced and the name cut to 80
  characters, so a long tool use id is cut), or, with no writable workspace
  or a failed write, the guard's audit record (`framework/tool-result-guard`),
  for an operator. The place holds the result as stored, which is its text:
  for a result over the inline cap, its capped text, whose own note names the
  file with the whole output. A failed write's own error stays in the audit
  record and the logs; the audit record also says when no file was written or
  a write threw. When saving the audit record itself
  had failed as the result arrived, the stub says so rather than that the
  original is kept there. This holds for every withheld settlement: a refusal,
  an aborted stream, a batch that was never submitted, and one whose audit sync
  failed. The notice still names no refusal and no category. Before this, a
  withheld result left only the notice, so the agent couldn't tell what the
  tool had done (agent-framework #277). The file is an ordinary workspace
  file: the agent can read it back deliberately, and so can whoever else reads
  the mount, such as another agent sharing it or a synced copy.
- How the stub is written. Where each original went is queued first, as an
  audit record of its own, and the stub's edit is then made at once. If it
  fails, it is retried before the next activation, compile of a request that
  is sent, maintenance pass or stop, including for an ephemeral run or a
  closed fork that has left the agent map, and the batch stays held out of
  summaries until it lands. Until then, or if the store keeps failing or the
  process stops first, the stub is the bare notice, and the `annotated` audit
  record describes the spill's outcome when the annotation finishes, with `unfinished` for a write still running. That record is not revised when the write later settles. A file whose copy on disk fails
  is still in the workspace's tree, where its tools read it, so the stub names
  it; for this, `WorkspaceModule.writeBinary`'s result for that case carries
  `data: { inChronicle: true }`, including when a post-commit operation throws. Inline truncation notes also name that readable tree file, and the disk-copy failure is logged and traced. Each batch has one 30-second deadline for all its withheld writes. A write still under way then is named as unfinished, with the audit record as the fallback. Nothing waits for it after that, stop included: it goes on by
  itself, and may finish or fail after the workspace has stopped. Until it
  settles, no other withheld original is written, for this batch or a later
  one of any agent: their stubs name the audit record. Writes can start before the first deadline fires; those batches each use their own deadline. A write that never settles keeps new withheld spills disabled for the process lifetime. Deadline and skip messages name affected files on stderr. The inline cap's spills are outside this deadline. Requests sent by the framework and the direct Agent API are compiled only once each annotation started so far has finished,
  including one that began while the compile waited or ran, and the refusal
  retry; a conversation fork seeded from its template copies only stubs whose
  annotation has finished. A request preview doesn't wait, so rollback,
  undo and redo never wait on a workspace write, and a preview can show a stub
  before its place is added, as can public `compileContext()`. Stop lets running annotations finish while the
  workspace is up; one that starts after that writes no file and is saved
  before the store closes. A crash before a stub is written leaves the notice
  alone, and the staged audit record still holds the original. If the active
  branch changes while the originals are being written, no more are written:
  a write that has not set its tree entry is refused where it commits, and it and the rest are recorded as skipped for the branch change. A write whose tree entry was already set remains on that branch. While the store is away the
  stub stays as it was; if the branch is back by the edit, those results'
  stubs name the audit record. So no original's tree entry lands on another
  branch. For this, `WorkspaceModule.writeBinary` takes an optional `branch`:
  the file's tree entry lands on that branch or isn't written, and a refused
  write's result carries `data: { branchLeft: true }` (it isn't traced as a
  failed spill). A mount has one directory on disk for every branch, so with
  `autoMaterialize` a file's copy there, made after its tree entry, is there
  whichever branch is active, like any other write's. The audit records `annotated`
  (where each original went) and `stub_updated` (the stub's edit) carry the
  batch's `sourceBranch`. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.

- With `maintenanceIntervalMs: 0`, periodic retries of retained guards are disabled; stop still retries them. A failing audit record blocks later queued edits and their compression holds until its write succeeds. Shutdown reports an error if that retry still fails.
- A framework-driven turn that compiled across stop is discarded before driving its stream, even if the framework has restarted. Restart reopens withheld spills. Direct Agent calls remain governed by their caller's abort signal; a refusal retry checks that signal again after waiting for annotations. Unguarded results are read after compilation, including on the retry.
- `save_recent_image` reports a tree-only write as saved, including its path, size, MIME type, and `diskCopyError`. A later failure in a multi-image save includes that file among the already-saved paths.

- `Agent.isCompilingRequest` is a read-only getter for the framework scheduler to keep a queued wake while request assembly owns the agent. Both direct and streaming entry points reject overlapping starts, and a failed compile releases that ownership. Existing public status values and request previews are unchanged.
