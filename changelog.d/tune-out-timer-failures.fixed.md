- A tune-out's cadence, coalesced wake or end time whose work throws, such
  as a store write that fails during the subconscious's turn, no longer
  throws into the event loop, where an uncaught exception ends the host
  process. The coordinator writes the error to stderr and reports a
  `tune-out:timer-failed` trace naming the timer. Before, a cadence whose
  turn threw also never armed again. Now it arms its next period before
  the turn, and that next turn counts the failed turn's messages.
