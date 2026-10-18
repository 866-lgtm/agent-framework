- A store failure while removing an agent's turn checkpoints no longer stops
  that agent's teardown partway. An ephemeral run, such as a subagent's,
  resolves with its result instead of rejecting with the store's error. A
  closing conversation fork's disposal runs to its end, through
  `mcpl:conversation-disposed`, where at its closure turn's end the stream
  rejected with nothing to catch it, an unhandled rejection that ends a Node
  or Bun process with no handler for one. The fallback reaper goes on to the
  next fork. The failure is logged as `[checkpoints] agent=…`, and those
  checkpoints stay in the store.
