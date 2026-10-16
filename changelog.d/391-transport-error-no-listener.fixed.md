- **A WebSocket MCPL server that sends a malformed frame with its upgrade
  response no longer ends the host** (#391). ws raised the frame's error
  before the handshake had attached a listener to the new transport, and
  the transport passed it on with nothing listening, which EventEmitter
  throws from an I/O callback. Such an error is now logged
  (`[mcpl] a websocket transport error, with nothing listening for it: …`),
  and the connect is refused.
- **A transport error no longer ends a process whose `McplServerConnection`
  has no `'error'` listener** (#391). The framework always listens, so hosts
  weren't affected, but a probe, a playtest or a harness holding a bare
  connection was. With no listener the error is now logged
  (`[mcpl] <server>: transport error: …`), and a listener that throws is
  caught and logged with the error it was handling.
