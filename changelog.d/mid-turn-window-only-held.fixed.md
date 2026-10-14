- A message deferred during a turn that can't join the live stream at a tool
  boundary — one carrying tool blocks, or named as the agent itself — now
  waits for the turn's end, after its last round, instead of being stored at
  the boundary between rounds the stream never showed it. Messages queued
  behind it wait with it, so the queue keeps its order; messages queued
  before it are still heard at the boundary. The cost: a message addressed to
  the agent but queued behind a held one isn't heard mid-turn, and waits for
  the turn's end. Stored between rounds, a held message sat before the turn's
  later replies in every later compile although their requests never held
  it: a prompt-cache divergence, and on a provider that binds signed thinking
  to the prefix it was minted under (anima-research/context-manager#155,
  whose binding anima-research/context-manager#160 walks), a reply whose
  thinking is refused.
- A message injected into the live stream at a tool boundary now counts as
  read for RFC-006 coalescing: the consumed watermark moves when messages
  are injected, not only at a compile. Before, an injected message sat above
  the watermark of the turn's compile, so a coalesced replacement for its
  subject could remove a message the agent had heard and answered. Within a
  branch the watermark only advances: a compile that started before such a
  mark doesn't roll it back when it finishes.
- A deferred write that a flush defers again does so whatever its content,
  under its id and in its place in the order writes arrived. That happens
  while its target's own turn, stream or tool cycle is alive, or the host is
  quiesced. (A write whose store throws goes back into the queue too; see
  below.) A `tool_result` used to land regardless, apart from the `tool_use`
  it answers, which went back into the queue.
- A write that waits now waits on its own target's state: the target's
  turn, stream and tool cycle, or a quiesced host. (A fresh `tool_result`
  still doesn't wait.) Before, a write for the primary agent waited out every
  agent's tool cycle, while one addressed to an agent waited only on that
  agent's. So a turn's end could store a later addressed message ahead of an
  earlier one for the primary, and a fork's, subagent's or the
  subconscious's tools held the primary's writes, which protected nothing in
  the primary's window. Each flush, at a turn's end, after surgery, after a
  withdrawn turn, after a start that ends before its stream and after a
  puppet call, now delivers the agent's deferred messages while another
  agent's tool cycle is pending; only the agent's own state holds them. The flush after surgery stores several agents' entries in
  the order they arrived, where it went agent by agent: residents share one
  message slot, so that reordered their shared transcript.
- `stop()` now stores what is still deferred for each registered agent
  before the store closes, in the order it arrived; before, a memory-only
  queue lost it. Once `stop()` begins, a new ephemeral run is refused, and
  an ephemeral run whose turn is refused because `stop()` has closed
  admission, or whose retry `stop()` cancels, ends at once rather than
  waiting for a watchdog. Since no turn starts or registers a stream once
  `stop()` begins (unless `start()` is called before it finishes), no reply
  can then follow a stored entry in a stream, so `stop()` stores each one
  even while a frame it doesn't wait for still holds its target's turn, such
  as a turn started outside the event loop, or a puppet call still running
  after `stop()`'s wait for operator operations timed out; that call's pair
  then lands after them. A quiesced host keeps what is deferred in its
  persisted queue for boot recovery. An entry for a target no longer
  registered (a disposed fork) is dropped from a memory-only queue at exit,
  as before.
- A deferred write whose store throws goes back into the queue under its id,
  and so does every entry queued behind it for that agent, so none of them
  lands ahead of an earlier one, and a queued `tool_use` that can't be
  stored keeps the `tool_result` queued behind it from being stored alone.
  (A stored `tool_use` whose `tool_result` then can't be stored stays alone
  until the result lands at a later flush.) Other agents' entries go on, in
  the order they arrived. The log line names the entry at each flush, and
  one that keeps throwing holds what is deferred behind it for that agent
  until it can be stored. The hold is the queue's: a write that isn't
  deferred is stored at once and can land ahead of a held entry. That's a
  fresh `tool_result`, a message assembled into the agent's turn before its
  compile (RFC-006 coalescing), and any write while the agent's turn, stream
  and tool cycle are idle and the host isn't quiesced. So an entry that
  keeps throwing holds only what is deferred while the agent's turn, stream
  or tool cycle is alive, or the host is quiesced. Before, it stayed in the
  un-acked set and the next acknowledgement dropped it from the persisted
  queue (at a turn start or a flush it was lost even from memory). At a tool
  boundary, nothing from it on is injected. While the framework runs it is
  kept; a memory-only queue still loses it when the process exits. A
  persisted queue (one a quiesce persisted, or boot recovery restored) keeps
  it across restarts: each boot restores it and tries it again with the rest
  of the queue, at once or at the resume after a quiesced boot, and logs it
  again, unless it's one boot drops (below). While it's held the queue stays
  persisted, so every later deferral is written to the recovery file, up to
  the file's size cap; past it the file isn't rewritten, as the host log
  warns, and what's deferred after that is kept in memory only. Only the
  host log names the held write.
- Boot recovery drops a recovered deferred write whose participant isn't
  text, whose content isn't an array, or that holds a null block, whose type
  can't be read, and logs it by id and participant, rather than holding it
  in the queue. An entry with a string or number block is restored with the
  rest of its blocks: the store keeps such a block as given, and membrane's
  formatters leave it out of requests. Before, an entry whose participant
  isn't text or whose content isn't an array was dropped without a line, and
  one with a null block was kept, where it could never be stored.
