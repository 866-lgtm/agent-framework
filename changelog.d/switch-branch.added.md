- `AgentFramework.switchBranch(name)` switches the store to an existing
  branch, reconciles the Discord awareness markers with it, re-materializes
  the config mount, and then resolves. The branch moves under every agent
  sharing the store, so, as for `rollbackToMessage()`, every agent must be
  idle: during a live turn it refuses with `OperatorActionError`
  (`agent-busy`), and no turn starts until it's done. Once `stop()` has
  begun it refuses, and `stop()` waits for one already running.
  - The API server's branch switch used to run these steps itself, on the
    store, and now calls `switchBranch()`. So it refuses during a live turn
    instead of moving the branch beneath it.
