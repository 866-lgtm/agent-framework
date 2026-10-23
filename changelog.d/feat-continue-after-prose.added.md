- **Hosts:** `AgentConfig.autoContinue` (default off): a turn the model ends
  itself, with prose or with nothing, is followed by another turn straight
  away, until the agent calls `skip_reply` (or another tool that ends the
  turn), ends on a `>>skip_reply` / `>>>skip_reply` envelope, or reaches
  `maxConsecutive` continuations in a row (default 3, 1 to 20; the count
  starts again on any wake with a cause of its own). As the next turn starts
  it reads a short `[continue]` system row (written only when the
  continuation is that turn's whole cause, never for a wake that is dropped)
  that names `skip_reply` as the way to stop and, near the cap, how many
  continuations are left; it keeps the turn's locus unless a batched message
  names another channel. Its wake has reason `auto-continue`. Refusals,
  `max_tokens` cut-offs, the stall guard's ends, silent heartbeat ticks and
  ephemeral runs never continue, and a ` !` continuation runs instead. A
  malformed setting is refused when the agent is built. New exported type
  `AutoContinueConfig`. See docs/auto-continue.md.
