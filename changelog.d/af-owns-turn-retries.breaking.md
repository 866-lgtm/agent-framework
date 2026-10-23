- **Hosts and custom `errorPolicy` authors:** the framework's turns now pass
  `retry: false` to membrane, so membrane sends a failed round once and the
  error reaches the framework after one send. The framework is the one retry
  layer for its turns: each retry is a fresh compile, a stop cancels its
  wait, and the wait is traced, where since membrane 0.7 membrane's own
  schedules (up to ten minutes at a 529) ran inside each of the framework's
  attempts, out of its sight. A custom `ErrorPolicy` now sees a failure that
  membrane used to retry first (a 5xx, a 529, a dropped connection, a 429),
  so it decides those itself. **Migration:** a custom policy that relied on
  membrane's inner retries can decide with membrane's own schedules:
  `classifyFailure` and `retryDecision` from `@animalabs/membrane/retry`, as
  the default policy now does, or wrap `DefaultErrorPolicy`, which is now
  exported. **Unchanged:** the provider holds before the policy (a resident's
  stated waits and acceleration 429s), refusal re-issues (`refusalRetries`),
  and what membrane does on calls that aren't turns (the MCPL inference
  router, compression and other host calls keep membrane's retries).
