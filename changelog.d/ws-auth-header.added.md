- A WebSocket MCPL server takes `tokenTransport: 'header'`, which sends its
  credential, the static `token` or what its `accessProvider` returns for
  each dial, as an `Authorization: Bearer` header on the upgrade, with no
  `token` query parameter. The credential then stays out of the url and of
  the proxy and server access logs that record it. The default,
  `tokenTransport: 'query'`, dials exactly as before. Refused as a
  configuration error (`serverConfigProblems`), and at the dial itself: a
  value other than `'query'` or `'header'`, `tokenTransport` on an
  http(s):// or stdio server, and `'header'` with a url that carries a
  `token` query parameter of its own. A header-mode credential holding a
  control character fails the dial, with an error that doesn't quote it.
