- What is still queued for an agent when it leaves the framework now leaves
  the deferred-write queue with it, at that moment, and the host log names
  each entry as lost, with the agent and where it left. An agent leaves at an
  ephemeral run's end and at a conversation fork's disposal. The last flush
  before it leaves can leave an entry there: one whose store threw, or, at an
  ephemeral run's end on a quiesced host, one that flush deferred again. A
  conversation fork isn't disposed while the host is quiesced: the end of its
  closure turn leaves it to the fallback reaper, which waits for `resume()` to
  store what is queued for it. Before, a closing fork's entry stayed queued
  for the disposed fork, where no flush could store it. An ephemeral run's,
  once the run's stream had ended, was dropped by the run's own turn-end
  flush, which runs after the run is deregistered, with a line saying its
  delivery target isn't a registered agent.
- The fallback reaper, which disposes a closing conversation fork with no
  stream and no request left for it, as when its closure turn never ran, now
  first stores what is still queued for the fork in the fork's own store, past
  its deferral, as the end of a closure turn and the end of an ephemeral run
  do. It waits to dispose the fork until that can be done: not while a turn
  token is held for it, as a puppet call or a surgery holds one, nor while the
  host is quiesced. The puppet call's end, the surgery's release and
  `resume()` each store the fork's queue, and a later sweep disposes it. Only
  what its store throws on then leaves with the fork, as above. Before, the
  reaper disposed such a fork while a token was held or the host was quiesced
  too, nothing stored what was queued for it, and that stayed queued for the
  disposed fork.
- Boot recovery numbers the restored deferred-write queue 1, 2, 3, … in the
  order it restores it, and later deferrals are numbered on from there.
  Before, it kept each entry's `seq` and numbered only the entries without a
  valid one, after the largest, so the counter went on from the largest valid
  `seq`: one at `Number.MAX_SAFE_INTEGER`, which boot accepts, gave every
  later deferral the same `seq`, 2^53. A recovery file whose `seq`s are all
  valid isn't rewritten at boot for the new numbers; the queue's next write
  carries them.
- At a tool boundary, a deferred message that the strategy stores as more than
  one message (a sharded body) is now injected as later compiles render it,
  its shards joined. Before, it was injected as given, so a body of more than
  one text block, or with a non-text block after a text block, reached the
  stream in a different shape from later requests.
