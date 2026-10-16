- **A transport error no longer ends a process whose `McplServerConnection`
  has no `'error'` listener** (#391). The connection passed each transport
  error (a WebSocket protocol error, say) on as its own `'error'`, which
  EventEmitter throws when nothing listens, from inside the transport's
  callback, where nothing caught it. The framework always listens, so hosts
  weren't affected; a probe, a playtest or a harness holding a bare connection
  was. With no listener the error is now logged
  (`[mcpl] <server>: transport error: …`), and a listener that throws is
  caught and logged.
