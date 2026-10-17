- `StdioTransport.close()` resolves for a child that a signal other than its
  own `kill()` has already ended, such as an OOM kill or a crash. It waited
  for an `exit` event that had already fired. So a connect or reconnect whose
  child died that way during `initialize` never settled, `close()` on its
  connection never settled, and `stop()` never returned, or, given a teardown
  timeout, failed when it ran out (#331).
- An error an MCPL transport reports while nothing else listens for it is
  now logged instead of thrown as an uncaught exception. That covers a
  transport that `McplServerConnection` keeps for `close()` while a
  reconnect's handshake finishes (#332), a transport whose handshake has
  settled until the connection takes it, and one that a failed handshake is
  closing. A malformed frame from a WebSocket server is such an error.
