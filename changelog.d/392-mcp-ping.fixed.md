- **An MCPL server's MCP `ping` is answered** with an empty result, as MCP
  asks, while its planes are paused too, and during the initialize handshake
  (#392). In 0.22.x a ping went unanswered, so a server with a keepalive could
  take the host for dead. During the handshake, a request whose id was `0`,
  the id the host gives `initialize`, was taken for the initialize response,
  so a server that pinged then connected as if it had advertised no MCPL
  capabilities.
