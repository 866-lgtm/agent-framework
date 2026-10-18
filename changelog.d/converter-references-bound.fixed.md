- A reference in a push event, a render result, an incoming channel message,
  a context injection or the successful result of an MCPL tool called in
  process is registered with the server that sent it, as the references in
  the result of an MCPL tool call the agent makes are, so `fetch_reference`
  can fetch it from that server. These were registered with no server, so
  `fetch_reference` refused them, unless a tool result had registered the
  same uri with its server. A reference now keeps every server that
  delivered its uri, and `fetch_reference` dials through the first of them
  whose address is on the uri's origin, with that server's credential and
  against its fetch budget, so a server off that origin sending it first no
  longer stops it being fetched. One on none of their origins is still
  refused, as a tool result's is.
