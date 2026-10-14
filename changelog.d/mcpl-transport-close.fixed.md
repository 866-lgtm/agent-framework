- `StdioTransport.close()` resolves for a child that a signal this process
  didn't send has already ended, such as an OOM kill or a crash. It waited
  for an `exit` event that had already fired, so a connect or reconnect
  whose child died that way during `initialize` never settled, and `close()`
  or `stop()` on its connection waited until its teardown timeout (#331).
- A transport that `McplServerConnection` keeps for `close()` while a
  reconnect's handshake finishes now logs an error it reports before it is
  closed, which was thrown as an uncaught exception (#332).
