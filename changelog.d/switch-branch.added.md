- `AgentFramework.switchBranch(name)` switches the store to an existing
  branch, reconciles the Discord awareness markers with it, re-materializes
  the config mount, and then resolves. The API server's branch switch used to
  run these steps itself and now calls it. Once `stop()` has begun it
  refuses, and `stop()` waits for one already running.
