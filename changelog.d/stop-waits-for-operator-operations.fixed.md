- **`stop()` waits for an operator's operation that is already running, and
  refuses new ones.** A quiesce, a resume, a `host/command`, a store surgery,
  an undo or redo's config materialization, a puppet tool call, an awareness
  sync, or an MCPL connect, disconnect or restart admitted before `stop()`
  began now finishes before the event gate, the modules, the MCPL
  connections and the store go. Before, such an operation kept running
  through the teardown. A resume waiting on its maintenance pass or previews
  could go on to leave quiesce while the host stopped, so the host booted
  unquiesced; a puppet call could find the store closed partway; a surgery
  could still be running at the final sync; a `host/command` could answer
  after its connection closed; and a connect could leave a connection that
  nothing closed.
  - Once `stop()` has begun, `quiesce()`, `resume()`, `rollbackToMessage()`,
    `suppressMessages()`, `undoLastTurn()`, `redo()`, `maintenanceTick()`,
    `puppetToolCall()`, `connectMcplServer()`, `disconnectMcplServer()` and
    `restartMcplServer()` are refused with "<verb> refused: the framework is
    stopping" before they read or change anything, as a `host/command`
    already was. `syncDiscordAwarenessMarkers()` isn't refused, because its
    callers, such as the API server's branch switch, have already changed
    the store when they call it. `stop()` waits for one that starts while
    it is waiting.
  - `stop()` also waits for what those operations start while it waits: the
    config materialization that undo, redo and the two surgeries start
    without waiting for it themselves. A failed materialization is logged.
  - A quiesce stops waiting for its drain, or for an abandon's grace, once
    `stop()` begins. `stop()` cancels the streams and waits for the event
    loop, but not for a turn that holds its token with no stream to cancel,
    so a quiesce cut short can report `drained: false`. The host stays
    quiesced, so it boots quiesced. A drain cut short logs that it stopped
    waiting and emits no `host:quiesce` trace, and an abandon it hadn't
    begun is left to `stop()`, which cancels the streams. An abandon whose
    grace is cut short reports its abandon as usual.
  - A resume is refused at its start once `stop()` has begun, whether or not
    the host is quiesced, and checks again after its maintenance and preview
    waits, before it leaves quiesce, so a quiesced host stays quiesced. A
    resume past that point finishes, its durable clear included, and its log
    says that the parked wakes it released won't run.
  - A host's trace listener that calls `stop()` from inside an operation,
    such as on its completion trace, doesn't lose that operation: `stop()`
    waits for it. A multi-turn `host/command` undo stopped that way is
    refused at its next turn and answers with the turns it undid.
  - While the host stops, an MCPL awareness barrier that fails no longer
    recycles the connections, which `stop()` is closing. It is released as
    a completed one is, so nothing waits on a rejected barrier, and unless
    the host is quiesced, what it held back reaches the listeners' stopping
    refusal.
  - **For operators:** `stop(teardownTimeoutMs)` bounds this wait too, with
    one budget for the whole wait, however many operations join it. An
    operation that outlasts it fails `stop()` with a `ShutdownTimeoutError`
    that names it, on its own or inside an `AggregateError` when other
    cleanup failed too. `stop()` still tears down the rest, while that
    operation may still run, and keeps the store open, so `stop()` can be
    called again. An awareness drain it waits for finishes its deliveries,
    each within its own deadline.
