- A WebSocket MCPL server takes `tokenTransport: 'header'`, which sends its
  credential, the static `token` or what its `accessProvider` returns for
  each dial, as an `Authorization: Bearer` header on the upgrade, with no
  `token` query parameter. The credential then stays out of the url and of
  the proxy and server access logs that record it. The default,
  `tokenTransport: 'query'`, dials exactly as before. A value other than
  `'query'` or `'header'`, or `tokenTransport` on an http(s):// or stdio
  server, is a configuration error (`serverConfigProblems`).
