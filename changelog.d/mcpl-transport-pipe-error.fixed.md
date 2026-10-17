- An error on a stdio MCPL child's stdin or stdout, such as a write's EPIPE
  from a child that closed its stdin but kept running, is now handled as the
  end of that child. Such an error was thrown as an uncaught exception, and
  where a host caught it, a child that kept running left the connection
  connected, with each request waiting out its timeout. Those pipes carry the
  protocol, so the transport sends the child SIGTERM if it's still running,
  and when the child exits, the transport's close names the error (`child
  process exited, and its pipe failed with write EPIPE`), unless the host had
  closed the transport first. The connection handles that close as any other
  exit: it rejects its pending requests, and reconnects if `reconnect` is set.
  A child that ignores SIGTERM keeps running, and its requests still wait out
  their timeouts. A read error on the child's stderr, which was thrown as an
  uncaught exception too, now reaches the transport's `'error'` listener if
  it has one and is otherwise dropped: once the connection is wired it ends
  nothing, and during a handshake it fails the handshake.
