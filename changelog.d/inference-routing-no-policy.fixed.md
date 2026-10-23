- An MCPL server's `inference/request` on a host that sets no
  `inferenceRouting` policy is refused before it reaches the provider, with
  `-32603` and a message naming `inferenceRouting`. Before, it went to the
  provider with the model `default`, which the Anthropic API doesn't serve
  (asked about it, the API answers 404 `not_found_error`), and a failed
  inference comes back to the server as `-32603` with the provider's
  message. The
  framework doesn't choose a model for the server: a model it picked would
  run, on whatever credentials and at whatever price it carries, for a
  server the operator never chose it for. A host whose membrane
  `beforeRequest` hook mapped `default` to a model of its own loses server
  inference until it sets `inferenceRouting`. The server's effective grant
  still lists `inferenceRequest` when it advertises it.
- A policy that names no model for a request's feature set refuses that
  request the same way, naming the feature set, where it sent an empty
  model on to the provider. A policy entry that is empty or not a string
  names no model: an empty `wildcards` entry is passed over, as empty
  `byFeature` and `overrides` entries already were, and an override or
  feature set named like an `Object.prototype` member (such as
  `constructor`) no longer reads one.
- The first refusal for each server is logged, naming what to set.
