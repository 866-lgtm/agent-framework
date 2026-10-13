- In explicit mode, a turn that a tool ends, such as with `skip_reply`, no
  longer leaves the prose it queued to run under the next turn's routing
  state. Such a turn settles before its earlier rounds' queued deliveries
  have posted, and in explicit mode the next turn can start at once. That
  start cleared the sticky destination those deliveries read when they
  post, so a queued unprefixed segment bounced into the next turn. Each
  turn now has its own routing state and receipt tallies (the sticky
  destination, the turn's destination, hybrid's hold, a ` !` continuation,
  and the destinations and suppressed segments its receipt reports), and a
  queued delivery keeps the one of the turn that queued it. In hybrid and
  locus mode the ended turn already keeps the next one waiting until its
  receipt is written, as before.
- The agent's prose deliveries go out in the order they were written,
  across turns: every stream queues its deliveries behind the agent's
  earlier ones, a fresh turn's included. A turn's text-only reply can
  therefore wait for an earlier turn's posts, up to their request timeout.
- In explicit and hybrid mode, a ` !` continuation that an earlier round
  asked for now starts when a tool ends the turn, once that turn's
  deliveries have run, unless the framework has stopped or the agent has
  been disposed by then. Before, hybrid mode started it only after the
  next turn, and explicit mode dropped it, or, when its delivery ran late,
  started it after the next turn.
- In hybrid and locus mode, a turn whose last response is empty writes its
  receipt, and checks for a continuation, after its last rounds' queued
  deliveries. Before, those deliveries were never receipted, or were
  counted in the next turn's receipt.
