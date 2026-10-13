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
  earlier ones, a fresh turn's included (apart from a stream that a later
  one replaced). A turn's reply, and its completion, can therefore wait for
  an earlier turn's posts: up to their request timeouts, one after another,
  or for good when `requestTimeoutMs` is 0 and a post is never answered.
- In explicit and hybrid mode, a ` !` continuation that an earlier round
  asked for now starts when a tool ends the turn, once that turn's
  deliveries have run, unless the framework has stopped or the agent has
  been disposed by then (a dropped one is logged). In explicit mode a turn
  that another event started meanwhile runs first. Before, hybrid mode
  started it only after the next turn, and explicit mode dropped it, or,
  when its delivery ran late, started it after the next turn.
- A logical turn now stays open from the start that opens it until the turn
  settles (it completes, a tool ends it, or it fails or is abandoned), and
  every start that routes prose while it is open continues it: a framework
  retry, the start that consumes unstreamed tool results (whichever wake
  the scheduler starts it with), the later start a provider-capacity hold
  defers a turn to. Each begins the sticky destination and hybrid's hold
  afresh, as before, but a ` !` asked for earlier in the turn still stands,
  in explicit mode too, and in hybrid and locus mode the receipt at the
  turn's end reports every stream's deliveries, including ones that land
  after a new stream began. Before, explicit mode dropped that ` !`, and the
  receipt counted only the deliveries that landed after the new start.
- A turn that completes now waits for its queued deliveries before its
  receipt and its continuation check, in every mode, whatever its last
  response. Before, only a completion with final text waited, so in hybrid
  and locus mode a stream whose last response was empty (a budget
  restart's, say) wrote its receipt first: those deliveries were never
  receipted, or were counted in the next turn's receipt. A ` !` they carried
  was missed too.
