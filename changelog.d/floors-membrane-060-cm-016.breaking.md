- **Hosts:** agent-framework now depends on membrane `^0.6.0` and
  context-manager `^0.16.0`, where it depended on `^0.5.87` and `^0.14.1`.
  context-manager 0.16.0 requires membrane `^0.6.0` itself, so the two
  install one membrane between them. What reaches a host through
  agent-framework, from those releases' notes:
  - **Your own membrane:** a host that builds its own `Membrane` and hands it
    to agent-framework raises its own `@animalabs/membrane` range to
    `^0.6.0`. context-manager counts a compression attempt's prompt through
    that instance, and with an older membrane it counts Gemini's cached input
    twice (below 0.5.81, OpenAI's too, and OpenRouter's on routes that report
    OpenAI's `cached_tokens`), so a compression fallback that fits can be
    rejected at admission and its chunk quarantined (context-manager 0.16.0).
  - **The kv-unified hysteresis certificate is on by default** for a
    strategy built from a recipe: a `kvUnified` block without
    `hysteresisCertificate` takes the certified exit, and
    `hysteresisCertificate: false` restores the full solver on every compile
    (context-manager 0.15.0).
  - **Content context-manager won't store** is refused at agent-framework's
    MCPL lanes and dropped at its deferred-write drains, as the entry on
    malformed content says.
  - **Anthropic streams:** after a stream's first event, SSE `ping`
    keepalives now count as activity for its idle deadline, so a stream that
    keeps sending only pings no longer ends at it (membrane 0.6.0).
  - **Media notes:** two of the notes membrane writes in place of media it
    doesn't send now say the model isn't seeing it. The first request after
    upgrading carries the new text wherever it renders such a note, so a
    provider's prompt cache misses once, from the first such note on
    (membrane 0.6.0).
  - The rest is in membrane 0.6.0's notes and context-manager 0.15.0's and
    0.16.0's.
