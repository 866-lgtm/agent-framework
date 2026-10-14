- `ProviderWaitNotSleptError`: when a retryable provider failure states a
  wait an ephemeral run won't sleep (longer than the 600 s it sleeps in its
  turn, infinite, or `NaN`), `runEphemeralToCompletion` now rejects with this
  error, carrying the wait as stated as `retryAfterMs`. Its message is the one
  the run ended with before, apart from a `NaN` wait, whose message now says,
  as the others do, that the run doesn't sleep a stated wait it can't read.
  Its `name` is `ProviderWaitNotSleptError`, so a logged rejection reads that
  where it read `Error`. A host that decides whether to run a task again can
  test `instanceof` or the `name` instead of reading the message. A host that
  matched the old wording missed the `NaN` ending; testing the name counts it
  with the others. Every other ending still rejects with a plain `Error`.
