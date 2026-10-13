- In explicit prose routing, when a round calls `skip_reply` itself (in
  native tool mode, and not from a `code_execution` script), the prose
  gateway no longer delivers or bounces that round's plain text.
  `skip_reply` promises that "Any plain text you wrote this turn stays
  private and is NOT posted". The round's segments used to go through the
  gateway like any other round's. Unprefixed text with no destination
  bounced: it went onto the clipboard for an `{{unsent}}` resend, got a
  bounce notice and could wake the resident again. Unprefixed text after a
  destination set earlier in the turn was published there. Now none of that
  round's envelopes is delivered or bounced, and none moves the destination
  or asks for a continuation. A `>>skip_reply {{unsent}}` in it still sets
  the retained text aside. A valid destination prefix, or a destination set
  earlier in the turn, can still send the round's text through the live
  outgoing stream as it is written.
- Explicit prose routing no longer streams unprefixed text to the trigger
  channel. The MCPL outgoing stream (`channels/outgoing/chunk` and
  `complete`) started with the trigger channel as its destination, so a
  streaming-capable server there received text that delivery would bounce.
  It now starts with no destination on a fresh turn, since explicit text has
  none until a `>>` prefix names one. When a tool-result-guard retry or a
  budget restart resumes the turn, it starts at the destination the turn's
  delivered rounds have set, decided at each round's end, so a private
  round's prefix doesn't count. The stream also reads a `>>` prefix after
  any leading whitespace, and ends its target at any whitespace, as delivery
  does, rather than streaming such a line as text or dropping it. Each
  round's text starts a new line for the stream, as delivery parses each
  round on its own: a round that began with a `>>` prefix streamed it as
  text to the previous round's destination.
- A turn resumed by a tool-result-guard retry or a budget restart now queues
  its prose deliveries behind the turn's earlier ones, in every mode, so the
  turn delivers in the order it wrote. Before, a resumed reply could be
  delivered ahead of an earlier round's queued envelope, to the destination
  that envelope was about to change.
