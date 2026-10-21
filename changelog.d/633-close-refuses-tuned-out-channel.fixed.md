- `channel_close` refuses a channel that's tuned out, as `channel_open` and
  `channel_decline` do, and says to cancel the tune-out with `tune_out` mode
  "cancel", which delivers what it diverted (#633). The channel can be closed
  after that. Until now the close answered success and ended the tune-out
  without its cancel, so its diverted backlog never reached the agent, and a
  later cancel found nothing to cancel. A module's close that certifies an
  idle lease (`overrideExplicitOpen`) is refused the same way, with
  `isError: false` and `data.refusal` `'tuned-out'`, so it can stand down
  as it does on the explicit-open refusal.
