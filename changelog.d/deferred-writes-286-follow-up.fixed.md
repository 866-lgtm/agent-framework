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
