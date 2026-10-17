- What is still queued for an agent when it leaves the framework now leaves
  the deferred-write queue with it, at that moment, and the host log names
  each entry as lost, with the agent and where it left. An agent leaves at an
  ephemeral run's end and at a conversation fork's disposal. The last flush
  before it leaves can leave an entry there: one whose store threw, or, on a
  quiesced host, one that flush deferred again. Before, a closing fork's entry
  stayed queued for the disposed fork, where no flush could store it. An
  ephemeral run's, once the run's stream had ended, was dropped by the run's
  own turn-end flush, which runs after the run is deregistered, with a line
  saying its delivery target isn't a registered agent.
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
