- The estimator calibration sample hands the context strategy the system
  prompt and tool definitions the request sent, beside the provider's input
  total, so the strategy compares that total with an estimate of the whole
  request, not of its compiled window alone (context-manager #323). Before,
  a tool-heavy agent's calibration multiplier learned its tool schemas as a
  per-token rate, or sat at 1.00 rejecting every sample as out of band. A
  context-manager without the second argument ignores it.
