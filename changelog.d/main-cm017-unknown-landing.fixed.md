- A deferred write refused as malformed no longer holds up following writes
  when store readback fails: context-manager validates the whole body and its
  shards before writing, so this refusal establishes that nothing was stored.
  Other errors with unknown landing remain queued and are reconciled by ID
  before retry, preserving order and avoiding duplicate writes.
