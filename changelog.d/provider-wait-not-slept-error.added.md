- `ProviderWaitNotSleptError`: when the provider states a wait longer than
  an ephemeral run sleeps in its turn (600 s), `runEphemeralToCompletion`
  now rejects with this error, carrying the wait the provider stated as
  `retryAfterMs` (`Infinity` when it is longer than can be represented,
  `NaN` when it isn't a number). Its message is unchanged. A host that
  decides whether to run a task again can test `instanceof` or the error's
  `name` instead of reading the message. Every other failure still rejects
  with a plain `Error`.
