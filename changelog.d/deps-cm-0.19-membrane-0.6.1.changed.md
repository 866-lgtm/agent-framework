- Requires `@animalabs/context-manager` ^0.19.0 (was ^0.18.0) and
  `@animalabs/membrane` ^0.6.1 (was ^0.6.0). context-manager 0.19.0 stores a
  lone UTF-16 surrogate half in edits and state writes as U+FFFD, where it
  left state the store couldn't read back, and fixes image-strip pricing;
  its subclass-facing breaking changes are in its own notes. membrane 0.6.1
  runs complete tool calls a provider returns under `stop_reason: end_turn`,
  where 0.6.0 ended the turn without running them.
