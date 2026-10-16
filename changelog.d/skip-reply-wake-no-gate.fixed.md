- Without an EventGate, `skip_reply` no longer offers `wake_in_seconds`; a
  positive timer argument supplied anyway is refused visibly without ending the
  turn, while ordinary `skip_reply` remains available.
