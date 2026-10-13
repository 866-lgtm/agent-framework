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
- A deferred write that goes back into the queue does so whatever its
  content. That happens while its target's own turn, stream or tool cycle is
  alive, or the host is quiesced. A `tool_result` used to land regardless,
  apart from the `tool_use` it answers, which went back into the queue.
- Every write now waits on its own target's state: the target's turn, stream
  and tool cycle, or a quiesced host. Before, a write for the primary agent
  waited out every agent's tool cycle, while one addressed to an agent waited
  only on that agent's. So a turn's end could store a later addressed message
  ahead of an earlier one for the primary, and a fork's, subagent's or the
  subconscious's tools held the primary's writes, which protected nothing in
  the primary's window. Each flush, at a turn's end, after surgery, after a
  withdrawn turn and after a puppet call, now delivers the agent's deferred
  messages while another agent's tool cycle is pending; only the agent's own
  cycle holds them.
- `stop()` now stores what is still deferred for each registered agent
  before the store closes; before, a memory-only queue lost it. Once `stop()`
  begins, no turn starts and no stream registers, for any agent: a turn that
  was mid-compile when the streams were cancelled, or one waiting to retry,
  is refused rather than left running, and an ephemeral run refused this way
  ends at once rather than at its startup watchdog. Since no reply can then
  follow a stored entry, `stop()` stores each one even while a frame it
  doesn't wait for, such as a puppet call, still holds its target's turn. A
  quiesced host keeps what is deferred in its persisted queue for boot
  recovery. An entry for a target no longer registered (a disposed fork) is
  dropped from a memory-only queue at exit, as before.
- A deferred write whose store throws goes back into the queue under its
  id, and so does every entry queued behind it for that agent, so none lands
  out of order and a queued `tool_use` and its `tool_result` stay together.
  The log line names the entry, and one that keeps throwing holds the
  agent's later deferred writes until it can be stored. Before, it stayed in
  the un-acked set and the next acknowledgement dropped it from the
  persisted queue (at a turn start or a flush it was lost even from memory).
  At a tool boundary, nothing from it on is injected. While the framework
  runs it is kept; a memory-only queue still loses it when the process
  exits.
