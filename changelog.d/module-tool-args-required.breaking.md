- **Module authors:** a module tool's call is refused before its handler
  runs when it lacks a key the tool's `inputSchema` lists in `required` (a
  key given as `null` counts as lacking it, unless its declared type admits
  `null`, by a type list naming it or `nullable: true`, or it declares no
  type), or when its input is there but isn't an object. **Who needs to
  act:** a module whose handler runs without a key its schema requires,
  since calls that leave the key out ran before and are now refused.
  **Migration:** if the key is optional, drop it from `required` and give
  its default in the property's description; if your handler needs it,
  keep it required: calls without it are now refused before your handler
  runs, telling the agent what to send. **Unchanged:** values (types,
  enums, nested shapes) are still the handler's to check; an absent input
  (`undefined` or `null`) still reaches a tool that requires nothing; a
  name the module answers but doesn't declare goes on unchecked; MCPL
  servers' tools keep their servers' own checks. connectome-host needs no
  change: its tools of this kind keep those keys required, since each such
  call did something its agent didn't ask for, such as storing a lesson
  without its content or starting a subagent named "undefined".
