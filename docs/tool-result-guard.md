# Tool result guard

The tool result guard is off by default. An agent can enable it through
`agent_settings`:

```json
{"action":"update","tool_result_guard":true}
```

Use `{"action":"get"}` to inspect the effective boolean and its source.
The setting persists across turns and process restarts. Set it to `false`
to disable it, or explicitly reset `tool_result_guard` to restore the recipe
default. Programmatic hosts can set `AgentConfig.toolResultGuard: true`.
A host that builds `AgentConfig` from a recipe must forward that key itself;
connectome-host does not forward it yet, so in that host a recipe
`toolResultGuard` line is currently a silent no-op — use `agent_settings`.
Disabling the setting never restores previously withheld output.

## Behavior

The guard applies to the batch of results returned together by the agent's
latest tool round, including text, images, and errors. It recognizes a
structured provider `stopReason: 'refusal'`, not keywords in output, ordinary
provider errors, or natural-language refusal text.

On that signal, every result in the batch is withheld. Tool calls, result IDs,
and error flags remain intact; each entire payload becomes the guard's notice,

> Tool result withheld by the guard. The tool has already executed.

followed by where the original is (see "Where a withheld original goes"
below). The same holds for every withheld settlement: a refusal, an aborted
stream, a batch that was never submitted, and one whose audit sync failed.

The refused attempt's partial assistant output is discarded. Inference is
retried once on the same model, within the same logical turn; executed tools
are never automatically run again. Refusal details stay in operational logs,
outside the agent-facing notice and setting description.

The guard takes precedence over Membrane's unchanged-input refusal retries
for a pending batch and its recovery attempt. A second refusal stops this
recovery without automatic rewind of older exchanges or human messages.
Explicit operator `/unstick` remains a separate action. A later clean tool
round can stage a new batch with its own single recovery allowance.

Guard effects apply only to a batch that was actually **submitted** to the
provider in the current turn. A batch whose turn ends before submission
(an `endTurn` tool such as `end_turn`/`skip_reply`, or results that arrive
after the response completed) is admitted immediately, recorded as
`accepted` with `reason: "turn_ended"`. A batch that compilation omitted
from the request is recorded as `withheld` with `reason: "unsubmitted"` when
a refusal arrives; that refusal then goes through ordinary refusal handling
(`refusalHandling.retries`/`autoRewind`), since the guarded output was never
on the wire.

Turn-ended admission also requires a durable audit. If staging or sync failed,
the result remains withheld with `reason: "audit_not_durable"`, including on
later turns.

While a submitted batch is pending, compilation reserves the originals' real
wire cost (chars/4 plus a flat per-image cost) in `reserveForResponse`, so
substituting them for the placeholders cannot push a restart's request past
its budget.

While a submitted batch is pending (or a recovery is running), streamed text
and its `inference:tokens` trace events are held at one publication
boundary; they are released in order on a clean round and discarded on a
guard refusal.

Normal successful rounds admit the preceding results to memory. This works
for framework yielding streams (including ephemeral agents and context-budget
restarts) and the backward-compatible direct `Agent.runInference` API.

## Chronicle and memory

Withholding is non-destructive. Before submitting a guarded batch, the host
appends a `staged` record to the Chronicle append-log state
`framework/tool-result-guard`. It contains the full `originals` (including
pre-truncation data, error strings, and image bytes), the serialized history
`content`, and the `wireResults`. A `linked` record connects its `batchId` to
the context message's `messageId`; later `accepted` or `withheld` records
record the outcome. No guard operation deletes or overwrites these records.
Payload fields larger than 10 KB use Chronicle blobs (`{blobId}`), following
the inference log convention; resolve them with `store.getBlob(blobId)` and
parse the JSON. The append-log snapshots retain the blob references.

The context manager initially receives only placeholders, so speculative
compression cannot incorporate output that is subsequently withheld. The
placeholder is not summarized while awaiting a decision: it is staged with a
context-manager compression hold (`addMessage(..., { holdCompression: true })`,
context-manager >= 0.12), placed before the strategy's ingress callback runs.
Every settlement path (accept, withhold, turn-ended, unsubmitted, aborted)
edits in the final content first and then releases the hold: an accepted
batch's payload, or a withheld batch's stub, which is edited once its
originals have been written, so a withheld batch stays held meanwhile.
Audit-only failures cannot keep a settled message held. If an acceptance
edit or a stub's edit fails, the guard keeps the content and its hold in a
separate retry queue; it does not re-arm provider submission or refusal
handling. Compression sees only the settled message: accepted output, or a
withheld batch's stub.
Holds are in-memory; a reopened process has no pending batch and therefore
no holds. Raw
pending output goes directly to the provider. A clean following response
promotes the history payload through Chronicle's versioned message-edit API.
On a refusal, the placeholders remain. The audit slot is not a context or
compression source.

The host calls `store.sync()` after the `staged`/`linked` records and before
the originals can be submitted. A failed staging/link append or sync fails
closed: it is logged (`[tool-result-guard] ... audit persistence failed`),
the provider receives placeholders instead of the originals, and the batch settles as `withheld`
(`reason: "unsubmitted"`). Output whose audit is not durable never reaches a
provider.

Failed edits and audit writes are retried in order before the next real
activation, compile of a request that is sent, or guard audit write, during
maintenance, and after stream teardown at shutdown, including those of an
ephemeral run or a closed conversation fork that has left the agent map.
Previews do not flush the queue. A history edit is retried only on its
original branch and only if the message still contains the guard's
placeholder or the content the edit writes; later operator edits, removals,
and branch changes take precedence. Such an edit is audited with
`historyUpdate: "superseded"` and its `sourceBranch` rather than overwriting
the operator's view. Originals in the audit are never edited or removed.

Storage retries are in-memory. If the process dies before storage recovers,
unsynced records or unfinished edits cannot be promised to survive. Originals
already made durable remain in Chronicle; reopened context conservatively
retains any withholding notice whose acceptance edit or stub edit did not
persist, and an `annotated` record that was saved still names a written file.

A stream that ends without a clean round and without a successor (abort,
exhausted error retries; also an aborted direct `Agent.runInference`)
settles its batch as `withheld` with `reason: "aborted"`, so a later turn
neither resubmits the originals nor treats its own refusal as the guard's.

If the process stops before settlement finishes, placeholders remain after
restart; originals whose audit reached durability are still available. This is
deliberately conservative: an interrupted submission does not establish that
the output was accepted. Similarly, if context compilation omits a pending
exchange, its unsubmitted payload is not admitted to memory.

## Where a withheld original goes

Each withheld result's original is written, as the result was stored (its
text; for a result over the inline cap, its capped text, whose own note names
the file with the whole output), to a file under the first writable mount's
`tool-results/` directory, named
`<date>-withheld-<batch>-<index>-<toolUseId>.txt` with any character outside
`A-Za-z0-9._-` replaced and the name cut to 80 characters. Its stub names it:

> Tool result withheld by the guard. The tool has already executed. Its result
> is in workspace file work/tool-results/2026-10-10-withheld-1a2b3c4d5e6f-0-toolu_01.txt.

Otherwise the stub names the guard's audit record, for an operator:

- with no writable workspace, or once the framework is stopping: "Its result is
  kept in the guard's audit record (framework/tool-result-guard), for an
  operator.";
- when the write failed: "Writing its result to workspace file … failed, so it
  is kept only in the guard's audit record …". The error itself stays in the
  audit record and the logs;
- when the write was still under way after 30 seconds, as on a stalled mount:
  "Its result was still being written to workspace file … when this note was
  made; if that file is missing, it is kept in the guard's audit record …".
  Nothing waits for that write after that, stop included: it goes on by itself
  and may finish or fail after the workspace has stopped. Until it settles, no
  other withheld original is written, for any agent; their stubs name the audit
  record, so a stalled mount costs one 30-second wait however many batches
  queue behind it.

When saving the staged audit record itself had failed as the result arrived,
the stub says the result went to the audit record "though saving that record
had failed when the result arrived", rather than that it is kept there.

The file is an ordinary workspace file. The agent can read it back
deliberately, and so can whoever else reads the mount: another agent sharing
it, a process, or a synced copy. Withholding keeps the original out of the
agent's context, not out of its workspace.

If the active branch changes while the originals are being written (a
rollback, an undo, a host's switch), no more are written, and the stub stays as
it was. A write already under way names the batch's branch, and the workspace
refuses it where it commits the file (`WorkspaceModule.writeBinary`'s `branch`
option, whose refusal carries `data: { branchLeft: true }`), so no original
lands on another branch. With `autoMaterialize`, a mount has one directory on
disk, and a written file's copy there is written like any other write's.

Two audit records describe it, each with `batchId`, `messageId` and
`sourceBranch`:

- `annotated`, written first, on its own: one entry in `results` per result.
  `{ toolUseId, path }` is a written file; with `error`, a failed write; with
  `unfinished: true`, a write still under way at the deadline. `{ toolUseId,
  error }` is a write that threw. `{ toolUseId, skipped }` is no write:
  `no_workspace_file` (no writable workspace, or the framework was stopping),
  `workspace_unanswered` (an earlier write was still under way past its
  deadline) or `branch_changed` (the branch changed before or while it was
  written).
- `stub_updated`: the stub's edit, with `historyUpdate: "superseded"` when an
  operator's edit, removal, rollback or branch change came first.

The stub's edit is made at once. If it fails, it waits in the retry queue
above, and the batch stays held until it lands, so no summary is made of a
stub that doesn't yet say where its original went; meanwhile the agent's
requests carry the bare notice, and the `annotated` record names the file.
Every request that is sent is compiled once each annotation started so far
has finished, including the refusal retry and the seed of a conversation fork
from its template. A request preview (rollback, undo, redo) doesn't wait, and
can show a stub before its place is added. At stop, the framework lets
running annotations finish while the workspace is up; one that starts after
that writes no file and is saved before the store closes.

For example, an operator can inspect records without changing the agent's
view:

```ts
const store = framework.getStore();
const records = store.getStateJson('framework/tool-result-guard');
// For large logs, use getStateLen/getStateItemJson instead of loading all.
const historical = store.getStateJsonAt('framework/tool-result-guard', sequence);
```

This is reactive recovery, not pre-submission screening: the provider sees
the original batch once before returning the signal. The setting is not
retroactive and does not rewrite results already accepted into memory.

## Known limits

- **Explicit-send suppression across a budget restart.** A guard recovery
  carries the same-turn send suppression, so a text-only recovery after a
  successful explicit send is not routed (locus/hybrid). Context-budget
  restarts still re-enter without it (inherited, unchanged here).
- **Audit growth.** Every guarded batch, accepted ones included, archives
  `originals`, `content`, and `wireResults` indefinitely. There is no
  retention policy and no restore tool; large payloads are blobs, but a full
  `getStateJson` read materializes the whole log.
- **Token stats.** The context manager's token-stats cache is not
  write-through on edit, so a stats read taken while a batch was pending can
  keep pricing that message as the placeholder.
- **Held stream text on abort.** Text held while a submitted batch is
  pending is dropped (not previewed) if the stream aborts or errors before
  the round settles.
- **Withheld originals in the workspace.** Every reader of the mount can read
  a withheld original's file, and nothing removes it; delete it as any
  workspace file.
