- A module tool's call is checked against the tool's declared input schema
  before the module runs: the input is an object, and every required key is
  present. A miss is refused with what to send, such as `Nothing was done:
  workspace--read needs "path" (a string), and this call gave none.`, with
  every missing key named at once, and the module never sees the call.
  Before, the call reached the handler, which could fail deep inside with a
  `TypeError`, or run without it: `workspace--grep` with no `pattern` matched
  every line. Values aren't checked for a module tool, since a handler may
  take more than its schema can say on every provider, such as the history
  module's single `author` where a list is declared. An MCPL server's tools
  keep their server's own checks.
- The `utils` tool's refusal of a run's arguments, which also checks each
  value's type and enum as before, now reads the same way ("Nothing was
  done: …"), and names every problem at once, still followed by the
  utility's schema.
