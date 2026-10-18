- `stop()` now runs every step of its teardown whatever an earlier step did.
  Before, a step that threw, such as a host's stream whose `cancel()`
  throws, ended `stop()` there: its modules and MCPL servers weren't
  stopped, the liveness watchdog went on beating, the framework stayed in
  the diagnostics registry, an ephemeral run still pending wasn't ended,
  and every later `stop()` failed the same way. Now `stop()` fails with
  that error once the rest has run, beside any other failure in an
  `AggregateError`, and an owned store stays open for another `stop()`, as
  after a failed module stop. A step in the last flush of deferred writes,
  which comes once everything else has stopped, fails the `stop()` as a
  failed final sync does, and the store is still synced and closed.
  - A stream whose `cancel()` threw is left running, as one whose wait ran
    out is: `stop()` doesn't wait for it, even with no budget, its agent's
    deferred writes stay queued, and a later `stop()` waits for it before
    it closes the store.
- `stop()` now ends Discord awareness delivery. A drain running when
  `stop()` begins sends nothing more, and the marks it hasn't sent stay
  pending in the outbox, unrecorded, for the next start's barrier. `stop()`
  waits, within `teardownTimeoutMs`, for each drain still running to record
  the call that closing its MCPL server ended. Before, `stop()` neither
  stopped nor waited for drains: once the servers had closed, a drain went
  on through its pending marks, recording each as a failed attempt
  ("Cannot send request: connection … is closed") though it sent none, and
  with many marks those writes went on after `stop()` had returned. After a
  `create()` whose awareness barrier failed on one server, another server's
  drain went on writing the outbox after `create()` had rejected, while a
  `create()` retried in the same process could already be using it.
  - A wait on drains that runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming `awareness drain:<server>` and keeps an
    owned store open; a later `stop()` waits for that drain again. With a
    budget, a `stop()` can now take up to six budgets.
