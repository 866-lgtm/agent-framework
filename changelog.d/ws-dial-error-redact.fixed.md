- A failed WebSocket dial's error no longer quotes the server's
  credentials. Under Bun, the WebSocket client's own message names the url
  as dialed (its user, password, path and query, and the token, a static
  one or an access provider's), and the dial's error carried that message
  on as it read, to the caller of `connectMcplServer` among others. The
  client's text now has each url in it shown as `redactUrl` shows one, and
  the strings the configuration and its dials know to be credentials
  replaced (`redactServerText`); the error has no `cause` holding the
  client's original. A client that throws as the socket is constructed is
  reported the same way. Node's `ws` quotes no url, so its errors read as
  before.
