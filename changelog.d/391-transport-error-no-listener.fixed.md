- **A WebSocket MCPL server that sends a malformed frame with its upgrade
  response no longer ends the host** (#391). ws raised the frame's error
  before the handshake had attached a listener to the new transport, and
  the transport passed it on with nothing listening, which EventEmitter
  throws from an I/O callback. Such an error is now logged
  (`[mcpl] <server>: a websocket transport error, with nothing listening for
  it: …`), and the connect is refused: at once when the server then closes
  the connection, as a WebSocket server does after answering the close frame
  ws sends, and after about 30 s when it never does.
- **A transport error no longer ends a process whose `McplServerConnection`
  has no `'error'` listener** (#391). A connection the framework wires always
  has one, but a probe, a playtest or a harness holding a bare connection
  often doesn't. With no listener the error is now logged
  (`[mcpl] <server>: transport error: …`), and a listener that throws is
  caught and logged with the error it was handling.
