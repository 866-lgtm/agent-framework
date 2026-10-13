- A turn that a tool ends, such as with `skip_reply`, no longer leaves the
  prose it queued to run under the next turn's routing state. Such a turn
  settles before its earlier rounds' queued deliveries have posted, and the
  next turn cleared the sticky destination those deliveries read when they
  post. In explicit mode a queued unprefixed segment then bounced into the
  next turn; in hybrid mode it went to the locus instead of the `>>>`
  destination. Each turn now has its own routing state (the sticky
  destination, the turn's destination, hybrid's hold and a ` !`
  continuation), and a queued delivery keeps the one of the turn that
  queued it. So that prose goes where its own turn sent it, and a
  continuation it asks for late can't reach the next turn. Every stream
  also queues its deliveries behind the agent's earlier ones, a fresh
  turn's included, so the agent's posts go out in the order they were
  written. The next turn still starts at once.
