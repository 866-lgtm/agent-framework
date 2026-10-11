- A tool result the guard withholds now says where its original is. The
  guard's notice ("Tool result withheld by the guard. The tool has already
  executed.") is followed by the original's place: a workspace file under the
  first writable mount's `tool-results/` (named
  `<date>-withheld-<batch>-<index>-<toolUseId>`, one per result), or, with no
  writable workspace or a failed write, the guard's audit record
  (`framework/tool-result-guard`), for an operator. A failed write's own error
  stays in the audit record and the logs. When saving the audit record itself
  had failed as the result arrived, the stub says so rather than that the
  original is kept there. This holds for every withheld settlement: a refusal,
  an aborted stream, a batch that was never submitted, and one whose audit sync
  failed. The notice still names no refusal and no category. Before this, a
  withheld result left only the notice, so the agent couldn't tell what the
  tool had done (agent-framework #277).
- How the stub is written. Where each original went is recorded first, and the
  stub's edit is retried before the next activation, maintenance pass or stop
  if it fails, so no written file goes unnamed. A file whose copy on disk fails
  is still in the workspace's tree, where its tools read it, so the stub names
  it; for this, `WorkspaceModule.writeBinary`'s result for that case carries
  `data: { inChronicle: true }`. A write still under way after 30 seconds, as
  on a stalled mount, is named as unfinished, with the audit record as the
  fallback, and the batch's remaining originals then go only to the audit
  record, so a stalled workspace can't hold the agent's requests or the
  framework's stop. Every request that is sent is compiled only once its stubs
  say where their originals went, including the refusal retry and a stub whose
  annotation began during the compile, and a conversation fork seeded from its
  template copies only such stubs. A request preview doesn't wait, so rollback,
  undo and redo never wait on a workspace write, and a preview can show a stub
  before its place is added. Stop lets running annotations finish while the
  workspace is up; one that starts after that writes no file and is saved
  before the store closes. A crash before a stub is written leaves the notice
  alone, and the staged audit record still holds the original. If the active
  branch changes while the originals are being written, no more are written, a
  write already under way is refused where it commits, and the stub stays as
  it was, so no original lands on another branch. For this,
  `WorkspaceModule.writeBinary` takes an optional `branch`: the file lands on
  that branch or isn't written. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.
