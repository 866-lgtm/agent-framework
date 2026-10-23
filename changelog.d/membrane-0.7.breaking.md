- **Hosts:** agent-framework now requires `@animalabs/membrane` ^0.7.1 (was
  ^0.6.1) and `@animalabs/context-manager` ^0.20.0 (was ^0.19.0), which
  admit no membrane 0.6.x. A host whose own membrane range is still ^0.6 gets
  two membrane copies, and an error one copy builds isn't an instance of the
  other's `MembraneError`, which the framework's error policy reads.
  **Migration:** move the host to membrane ^0.7.1 with this release
  (connectome-host 0.13.0 does). The framework calls through the `Membrane`
  its host passes in, so membrane 0.7's retry changes reach its turns through
  the host's retry config: since 0.7, membrane also retries on
  `streamYielding()`, the turn path, inside each of the framework's own
  attempts, and the framework's error policy retries above it as before.
  **Unchanged:** the framework's error policy and what it does with a
  failure that reaches it.
