- After a `stop()` that cancelled a turn's retry, a `start()` on the same
  framework (one whose store it doesn't own, or whose `stop()` failed)
  delivers the event gate's debounced batches again. The cancelled turn
  left its agent inferring at the gate, so every batch was buffered, and
  woke no agent, until that agent's next turn ended.
  `EventGate.dispose()`, which `stop()` calls once its streams and event
  loop have ended, now clears which agents are inferring. A turn that
  continues another, such as a budget restart left queued that a `start()`
  takes up, marks its agent inferring again through the new
  `EventGate.onInferenceResumed()`, which, unlike `onInferenceStarted()`,
  leaves a pending self-wake alone.
