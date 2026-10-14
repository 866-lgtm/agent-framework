- The host no longer posts into a channel its server declared inbound-only
  (`direction: "inbound"`, SPEC §14.2). pocket-body's live transcript,
  `body:ears`, is such a channel, and an agent speaking in the room arrives on
  it addressed. Until now that moved a resident's plain speech there, the
  delivery attempt opened the channel if she had closed it, and pocket-body
  refused the publish.
  - Plain speech aimed there is refused before the channel is opened or
    published to, and the send-failure marker names the declaration.
  - A `>>` or `>>>` target naming the channel bounces with the same reason,
    and the closed-channel invitation offers no reply into it.
  - `channel_publish` and the subconscious's `speak_in_channel` return an
    error that names it. The outgoing stream skips the channel, and the
    channel context names no default outgoing channel for it.
  - The routing notices say plain speech is refused there, and to use that
    server's own tools. The locus and hybrid mode primers, shown when an
    agent's mode changes, say plain speech goes to the locus unless its server
    declared that channel inbound-only.
- `speak_in_channel`'s `mcpl:speech-routed` trace now follows a publish the
  server accepted and didn't report undelivered, with the fields
  `routeSpeech`'s trace has (`serverId`, `delivered`, `textLen` and the
  surface's `messageId`). A refused or undelivered publish is traced as
  `mcpl:speech-route-failed` instead.
