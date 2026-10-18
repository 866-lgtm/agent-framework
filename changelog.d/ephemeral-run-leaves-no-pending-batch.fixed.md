- An ephemeral run that leaves while its tool-result guard still holds a batch now settles
  the batch as it leaves, before the agent is deregistered. The batch is withheld, so its
  stubs say where each original is, as for any withheld batch, and the guard's audit
  records how it ended. Until now several ways out left the batch pending on an agent
  nobody would run again, with no `withheld` record and no stub naming where its originals
  are: a failure whose stream ended only after the run's caller had deregistered the
  agent, a budget restart or error retry whose new start failed, a run the completion
  watchdog ended, and `stop()`'s sweep of the runs still registered. The record reads
  `run_stalled` when the completion watchdog ended the run as stalled, and `aborted`
  otherwise, as driveStream's own teardown records a stream that ended without a clean
  round.
