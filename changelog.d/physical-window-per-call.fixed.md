- The physical-window projection (#92) projects from the stream's latest
  provider call. Membrane's usage event is the stream's running total across
  the tool loop, and the projection added it as the prior call's prompt and
  output, so from the boundary after a stream's second call on, an agent with
  `physicalWindowTokens` set could restart its stream even when the next
  request would have fit. Its physical-window restart now comes only when the
  latest call's prompt and output, the round about to be appended and the
  response reserve together cross the window (`maxStreamTokens` still
  restarts on its own), and the `inference:stream_restarted` trace's
  `inputTokens` for a `physical_window` restart is that projection. A call
  whose usage reports no prompt adds to the projection what the stream grew
  by since the last call that reported one: the blocks appended since, and
  its own output, or `maxTokens` when it reported no output either. The
  projection runs once a call on the stream has reported a prompt.
  `Agent.lastStreamRealInputTokens` and `lastStreamOutputTokens` hold the
  latest call that reported a prompt, which is what the provider billed;
  `Agent.lastStreamUnreportedTokens` holds the growth since.
  `lastStreamInputTokens` stays the stream's accumulated fresh input, which
  is what `maxStreamTokens` checks.
