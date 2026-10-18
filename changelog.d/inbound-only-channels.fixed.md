- The host no longer publishes into a channel its server declared inbound-only
  (`direction: "inbound"`, SPEC §14.2). A server's live-transcript channel can
  be one, where an agent speaking in the room arrives addressed. Until now
  that moved a resident's plain speech there, the delivery attempt opened the
  channel if she had closed it, and the server refused the publish.
  - Every publish of plain speech into such a channel is refused before the
    channel is opened or published to, a drafts resend and `{{unsent}}`
    included, with a reason that names the declaration and says to use that
    server's own tools. A channel declared inbound-only while the host opens
    it, or removed meanwhile, is refused too, and nothing is published to it.
  - A `>>` or `>>>` target naming the channel bounces with the same reason,
    and the closed-channel invitation offers no reply into it. In explicit
    mode the refused target also clears the turn's destination, so the turn's
    later text without a prefix bounces too, rather than going to the
    destination named before it. A delivery refused because the channel was
    declared inbound-only after its target resolved ends the destination
    too, unless a later round has named another channel by then.
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
- A server's error response reaches the resident in the server's own words,
  naming the server: in the send-failure marker, in a draft's recorded
  outcome, in the errors of `channel_publish`, `speak_in_channel`,
  `channel_open` and `channel_close`, and in `channel_decline`'s
  `acknowledgmentError` when its acknowledgement request fails. A publish
  answered with an error still says delivery wasn't confirmed.
  `McplRequestError` carries those words as `serverMessage` on an
  `error-response`, bounded as its message is.
- A server's error response, to a request the host sends once the connection
  is up, now says what came whatever it holds, in `serverMessage` and in the
  error's message: text sent in place of an error object is still the
  server's words, a missing message says so, a missing code reads `none`, and
  a message that isn't text, a code that is neither a number nor text, or an
  error that is neither an object nor text, is shown as JSON, bounded.
- `speak_in_channel`'s `mcpl:speech-routed` trace now follows a confirmed
  delivery, with `serverId`, `delivered` and `textLen` as plain speech's trace
  has them, and no `messageId`, as before. Any other result is traced as
  `mcpl:speech-route-failed`, with the publish's reason, the connector's
  detail when it sent some, and `outcome: "unknown"` when the words may have
  been posted or `"failed"` when nothing was, a refusal included.
