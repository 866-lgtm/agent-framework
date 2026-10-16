- **An MCPL server's MCP `ping` is answered** with an empty result, as MCP
  asks, while its planes are paused too, and during the initialize handshake
  (#392). A ping went unanswered before, so a server with a keepalive could
  take the host for dead. During the handshake, a ping whose id was `0`, the
  id the host gives `initialize`, was taken for the initialize response, and
  the host connected as if the server had advertised no MCPL capabilities.
