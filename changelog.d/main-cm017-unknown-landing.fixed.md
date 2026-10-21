- A deferred write refused as malformed is dropped only after readback confirms
  nothing was stored. If its landing cannot be read, it remains queued and is
  looked up by its stable ID before retry, preserving order and avoiding a
  duplicate write after an ambiguous failure.
