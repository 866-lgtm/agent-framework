- The default error policy decides a turn's retries on membrane's schedules
  (`@animalabs/membrane/retry`, `MEMBRANE_RETRY_SETTINGS` unless a host gives
  `new DefaultErrorPolicy(settings)` as `errorPolicy`), where it retried any
  retryable failure three times, 1, 2 then 4 s apart. A 529, or an overloaded
  error mid-stream, gets the overloaded schedule: seven tries, jittered waits
  from 10 s doubling to five minutes. A 429 gets at least five tries on the
  base schedule. Any other retryable failure, a stream deadline included
  (membrane itself leaves a deadline to its caller), gets three tries, 1 s
  then 2 s. A provider's stated wait is waited when it is longer than the
  backoff, up to a minute; past that the turn ends, as membrane would end
  the call. A failure that isn't retryable ends at once, as before, and an
  error that isn't a MembraneError is retried as before.
