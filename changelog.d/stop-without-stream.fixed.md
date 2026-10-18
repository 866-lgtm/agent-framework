- **A stop reaches a turn that has no live stream.** A turn can be alive
  with no stream to carry a stop: while it runs its modules'
  `gatherContext`, its MCPL hooks or its compile, while it waits to retry a
  failed inference or a failed compile, and while the tool-result guard
  waits for its speech to go out before retrying a refused round, when it
  holds only the round's finished stream. In the first two,
  `Agent.cancelStream()` had nothing to cancel, the framework's
  `abortInference()` returned `false`, and an operator's quiesce abandon
  left the turn running. In the guard's wait, the round's finished stream
  was cancelled and `abortInference()` returned `true`, but the retry was
  sent anyway. The turn went on to send its request or its retry, and
  answered, and an abandoned one did so while the host was quiesced. Now
  it ends at its next check, before it sends anything more.
  - **What a host sees:** one `inference:aborted` with the stop's reason,
    instead of a turn that goes on. The agent's `[turn-interrupted]` note
    says the turn was stopped before it sent anything, or before it
    finished; an operator's abandon writes no note. The inference log gets
    the stop's row, as for a stop on a live stream:
    `Stream cancelled (<reason>)`, or `Stream aborted: quiesce_abandoned`
    for an operator's abandon. The framework's `abortInference()` returns
    `true` for such a turn. `abortInference()` and an operator's abandon end
    a turn's wait to retry, however long, so the turn ends at once; a stop
    through `Agent.cancelStream()` ends it when the wait runs out. A stop
    made while a failed inference's `inference:failed` is delivered ends the
    turn there, before a hold or a retry. In the tool-result guard's wait,
    `stop()` and an operator's abandon end the turn as their own stop even
    when a caller's stop came first.
    `host:quiesce`'s `unabandonable` lists a turn with no stream that the
    abandon hasn't ended when its grace runs out: one with no check ahead,
    such as a puppet tool turn, or one that hasn't reached its check yet. A
    turn whose stream the abandon cancelled isn't listed, even one still
    running, as one whose tool-result guard waits on its speech may be.
  - **A stop followed by a failure:** when a turn's hooks or compile fail
    after a stop reached it, the turn ends at the failure: its
    `inference:failed`, then its `inference:aborted`. It isn't held by a
    provider hold, and the error policy doesn't retry it. A failure that
    would have exhausted the turn emits no `inference:exhausted`, the event
    from which the hard-down alert's failure streak, the over-budget drain
    and the poison-history breaker count failures, so none of them counts
    it.
  - **A stop made where no check of a turn is ahead ends nothing:** the
    agent's next turn runs, as after a host's interrupt of every agent.
    That covers an idle agent, a turn finishing its last delivery, a budget
    restart or a non-streaming turn's tool results waiting to start the
    turn's next call, and a turn a provider-capacity hold or a provider's
    stated wait has parked.
