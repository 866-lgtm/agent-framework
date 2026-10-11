- Connecting to an MCP server warns once when a credential would cross the
  network unencrypted, to an `http://` or `ws://` url whose host isn't this
  machine: its `token` or `accessProvider`, or a secret the url carries
  itself (userinfo, a query parameter whose name says credential: `token`,
  `key`, `secret`, `password`, `auth` or `signature`, or a path segment
  that looks like one, as the redacted url judges it). Loopback hosts are
  exempt, and so are the unspecified addresses `0.0.0.0` and `[::]`, which
  reach this host too. It warns rather than refuses, since a private network
  or a TLS-terminating proxy can make that deliberate.
  `serverConfigWarnings` is exported beside `serverConfigProblems`, so a host
  can apply the same check in its own configuration validation.
