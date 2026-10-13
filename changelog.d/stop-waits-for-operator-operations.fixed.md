- **`stop()` waits for an operator's operation that is already running before
  it tears down what that operation uses.** A quiesce, a resume, a
  `host/command`, a store surgery (`rollbackToMessage`, `suppressMessages`)
  or an awareness sync (`syncDiscordAwarenessMarkers`) admitted before
  `stop()` began now finishes before the event gate, the modules, the MCPL
  connections and the store go. Before, such an operation kept running
  through the teardown: a resume could clear the durable quiesce mark and
  reopen the data planes after the final sync, a surgery could find its
  store closed partway, and a `host/command` answer could miss its
  connection.
  - A quiesce stops waiting for its drain, or for an abandoned turn's grace,
    once `stop()` begins. `stop()` ends the turns itself. The host stays
    quiesced, so it boots quiesced.
  - A resume that hasn't left quiesce when `stop()` begins is refused with
    an error, and the host stays quiesced. One that has left it finishes,
    its durable clear included, before the final sync.
  - `quiesce()` and `resume()` called once `stop()` has begun are refused
    with an error, as a `host/command` already was.
  - A failed awareness drain no longer recycles the MCPL connections of a
    host that is stopping, since `stop()` is closing them.
  - **For operators:** `stop(teardownTimeoutMs)` bounds this wait too. An
    operation that outlasts it fails `stop()` with a `ShutdownTimeoutError`
    that names it, and the store stays open, as for a module whose teardown
    timed out, so `stop()` can be called again.
