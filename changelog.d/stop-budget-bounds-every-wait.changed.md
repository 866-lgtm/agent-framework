- `stop(teardownTimeoutMs)` now bounds every wait it makes when it's given
  a budget: on the streams it cancels, on maintenance in flight, and on the
  event loop, as well as on an operator's operations and on modules and
  MCPL servers, as before (#373). Each wait takes the whole budget, so a
  `stop()` with one can take up to five budgets, besides the withheld-spill
  deadline of a guard's write still under way. Before, a stream whose
  cancel couldn't reach it, a maintenance tick that didn't settle, or a
  module's `onProcess` that never returned kept `stop(t)` waiting without
  end, whatever `t` was. With no budget, `stop()` waits for each as before.
  - A wait whose budget runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming what it waited for (`stream:<agent>`,
    `maintenance` or `event loop`), once teardown has gone on, and leaves
    an owned store open, so that `stop()` can be called again, as after a
    timed-out wait on an operator's operations.
  - An agent whose stream outlasted its wait keeps its deferred writes
    queued, logged once for that agent, where `stop()` would otherwise
    store them ahead of what the stream may still write. The stream's own
    end takes them, as at any turn's end, if the process lives on, and a
    later `stop()` takes what that leaves.
  - Every ephemeral run still registered is ended, as after any `stop()`.
  - An event loop still in a call, such as a module's `onProcess`, when
    its wait runs out finishes that call and the rest of its iteration,
    then exits, even when a `start()` has been made meanwhile. The same
    holds for a loop that a `start()` made during a `stop()` finds still
    running: before, it could go on taking events beside the new loop.
