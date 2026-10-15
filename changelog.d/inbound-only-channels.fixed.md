- The host no longer publishes into a channel its server declared inbound-only
  (`direction: "inbound"`, SPEC §14.2). A server's live-transcript channel can
  be one, where an agent speaking in the room arrives addressed. Until now
  that moved a resident's plain speech there, the delivery attempt opened the
  channel if she had closed it, and the server refused the publish.
  - Plain speech aimed at a channel the host knows is inbound-only is
    refused before the channel is opened or published to, and the
    send-failure marker names the declaration.
  - A `>>` or `>>>` target naming the channel bounces with the same reason,
    and the closed-channel invitation offers no reply into it. In explicit
    mode the refused target also clears the turn's destination, so the turn's
    later text without a prefix bounces too, rather than going to the
    destination named before it.
  - `channel_publish` and the subconscious's `speak_in_channel` return an
    error that names it. The outgoing stream skips the channel, and the
    channel context names no default outgoing channel for it.
  - A channel the host knows only from a push is refused once the server's
    answer to opening it, wherever the host opens it, declares it
    inbound-only.
  - The routing notices say plain speech is refused there, and to use that
    server's own tools. The locus and hybrid mode primers, shown when an
    agent's mode changes, say plain speech goes to the locus unless its server
    declared that channel inbound-only.
- When a server answers a publish of plain speech with an error, the agent
  gets the send-failure marker with the server's own message, and an
  `mcpl:speech-route-failed` trace goes out. Before, the error was only
  logged, unless the text had a hybrid `>>>` target, which bounced it. Any
  other failed publish still rejects as before: one that times out or loses
  its connection before an answer, whose outcome is unknown, or one whose
  connection was already closed. Plain speech logs it, and a hybrid `>>>`
  target bounces it.
- Speech into a channel that is removed while the host opens it is refused,
  and nothing is published to it.
- `speak_in_channel`'s `mcpl:speech-routed` trace now follows a publish the
  server accepted and didn't report undelivered, with the fields
  `routeSpeech`'s trace has (`serverId`, `delivered`, `textLen` and the
  surface's `messageId`). Any other outcome, as the tool's result reports
  it, is traced as `mcpl:speech-route-failed`: a refusal, a publish the
  server reported undelivered, or one that failed, a timeout included.
