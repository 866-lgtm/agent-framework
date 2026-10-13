- A start that continues a logical turn now keeps what the turn has decided
  about where its speech goes. Those starts are a framework retry after a
  stream error, the re-inference that consumes unstreamed tool results, and
  the compile a provider-capacity hold defers a turn to (#314). Before, each
  began with fresh routing:
  - in hybrid mode, the hold after `>>>skip_reply` was dropped, so the new
    stream's unprefixed prose was published to the turn's locus;
  - the sticky destination was dropped in both modes, so unprefixed prose
    went to the locus in hybrid mode, and in explicit mode bounced with a
    notice and a wake, while the new stream streamed nothing;
  - the turn's locus was resolved again: a retry lost a mid-turn addressed
    re-pin, a re-inference took the locus of whichever wake started it, and
    a held turn's later compile let a newer ambient message move it.
- At a start that continues the turn, a wake that arrived after the turn
  began moves the turn's locus only as a mid-turn message does: when it
  addressed the agent, or came from a channel the turn sent into. The agent
  gets the same `[routing] The conversation moved to …` notice. Ambient
  traffic in another channel no longer moves a held turn's locus.
