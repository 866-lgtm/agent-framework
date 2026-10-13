- **`Module.onToolBatchComplete(agentName)`**: called once an agent's tool batch completes,
  when the round's last pending result arrives and before it is provided. It therefore runs
  before anything that continues the turn: re-inference, stream resume or the end of the turn.
  The framework awaits every module's hook in parallel, each bounded at 30 s and fail-open; a
  hook that throws (before returning its promise or after) or times out is traced as
  `module:batch_hook_failed` and the round goes on.
  The agent's state is checked again afterwards, so a result whose turn was cancelled or
  replaced during the hook is dropped (traced as `tool:result_dropped`). A hook still running
  from an earlier batch, past its bound, is skipped rather than called again. The hook is
  awaited in the framework's event loop, so a slow one holds every agent's event processing,
  not only the batch's agent. Script-inner tool calls don't trigger it, nor does a batch whose
  error results the framework fills in after its stream ended before its tools answered.
- Workspace: `materialize` accepts `applyDeletions`, `WorkspaceConfig` accepts
  `agentActionScanDeadlineMs` (default 20000, kept below the hook's 30 s bound), and
  `workspace:deleted` events carry `conflicts` when a disk deletion met a newer workspace edit.
