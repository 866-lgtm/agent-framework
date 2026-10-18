- **Requests an MCPL server sends while its plane is paused are bounded**
  (#387). During a startup, a reconnect, an awareness drain or a quiesce,
  held requests had no bound, so a server that sends requests without
  waiting for their answers grew the host's memory until it ran out. Past
  10,000 held requests, a new one is now answered at once with `-32000`
  "the host is busy: 10000 of this server's requests are already waiting;
  send this one again later", and the host logs the first refusal and every
  hundredth. A server that doesn't send a refused request again loses it.
  Notifications keep their own bound of 1,000, now counted apart from
  requests. Before, held requests counted toward it, so a pause holding many
  requests dropped notifications it had room for.
