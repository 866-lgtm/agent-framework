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
- How the stub is written. Where each original went is recorded first, and the
  stub's edit is then made at once. If it fails, it is retried before the next
  activation, compile of a request that is sent, maintenance pass or stop,
  including for an ephemeral run or a closed fork that has left the agent map,
  and the batch stays held out of summaries until it lands. Until then, or if
  the store keeps failing or the process stops first, the stub is the bare
  notice and the audit record names the file. A file whose copy on disk fails
  is still in the workspace's tree, where its tools read it, so the stub names
  it; for this, `WorkspaceModule.writeBinary`'s result for that case carries
  `data: { inChronicle: true }`. A write still under way after 30 seconds, as
  on a stalled mount, is named as unfinished, with the audit record as the
  fallback. Nothing waits for it after that, stop included: it goes on by
  itself, and may finish or fail after the workspace has stopped. Until it
  settles, no other withheld original is written, for this batch or a later
  one of any agent: their stubs name the audit record, so a stalled workspace
  costs one 30-second wait however many batches queue behind it, and can't
  hold the agent's requests or the framework's stop. Every request that is
  sent is compiled only once each annotation started so far has finished,
  including one that began while the compile waited or ran, and the refusal
  retry; a conversation fork seeded from its template copies only stubs whose
  annotation has finished. A request preview doesn't wait, so rollback,
  undo and redo never wait on a workspace write, and a preview can show a stub
  before its place is added. Stop lets running annotations finish while the
  workspace is up; one that starts after that writes no file and is saved
  before the store closes. A crash before a stub is written leaves the notice
  alone, and the staged audit record still holds the original. If the active
  branch changes while the originals are being written, no more are written, a
  write already under way is refused where it commits and recorded as skipped
  for the branch change, and the stub stays as it was, so no original lands on
  another branch. For this,
  `WorkspaceModule.writeBinary` takes an optional `branch`: the file's tree
  entry lands on that branch or isn't written, and a refused write's result
  carries `data: { branchLeft: true }` (it isn't traced as a failed spill). A
  mount has one directory on disk, so with `autoMaterialize` the file's copy
  there is written like any other write's. The audit records `annotated`
  (where each original went) and `stub_updated` (the stub's edit) carry the
  batch's `sourceBranch`. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.
