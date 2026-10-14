- A stdio MCPL server whose command can't be spawned, such as a command that
  doesn't exist, now fails its connect or reconnect attempt like any other
  refused connect. Node reports a failed spawn after `spawn()` has returned,
  and a reconnect attempt, which runs from a timer, got that report before
  anything listened for it, so it was thrown as an uncaught exception, which
  ends a host that has no `uncaughtException` handler (#336).
