- Depends on `@animalabs/context-manager` `^0.14.0` (was `^0.13.0`). Under
  `foldingStrategy: 'kv-unified'` the strategy no longer persists its
  presentation receipt as one entry per message on every accepted call: the
  receipt is stored run-length encoded, so a Chronicle `records.log` no longer
  grows quadratically with session length (context-manager#148). Stores written
  under 0.13.x still load. Patch release from the v0.21.0 tag with this
  dependency bump only; the work on `main` since 0.21.0 is not included.
