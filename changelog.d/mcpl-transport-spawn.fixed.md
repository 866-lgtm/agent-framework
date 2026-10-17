- A stdio MCPL server whose command can't be spawned, such as a command that
  doesn't exist, now fails its connect or reconnect attempt with
  `MCPL server "<id>" could not be started: ` and the runtime's spawn error,
  such as Node's `spawn <command> ENOENT`, which is also its `cause`. Node
  reports a failed spawn after `spawn()` has returned, and a reconnect
  attempt, which runs from a timer, got that report before anything listened
  for it. So it was thrown as an uncaught exception, which ends a host that
  has no `uncaughtException` handler (#336).
