- A channel server can no longer supply the metadata keys that only the host writes on a stored message. A `channels/incoming` message's `metadata` and a push event's `origin` are now stored without `system`, `kind`, `draftOwner`, `draftIds`, `tuneOut`, `coalescingSubject` and `firstView`, and the host writes its own after them, as it already did for `firstView` and the inbound source envelope. Each of these is a key some reader takes on its own as what the message is, so until now a server's message could pass for one the host wrote:
  - with `kind: "discord-send-failed"`, a message left unread in a conversation fork's window made the host tell the primary, when the fork was released, that the fork's reply had failed, in a `system` notice carrying the server's `reason` and `detail` text;
  - with `system: true`, a message counted as the host's own notice: it didn't count as conversational input, and the refusal rewind never shed it;
  - with `tuneOut`, a message was held from every resident for good, as a tune-out holds what it diverts;
  - with `draftOwner` and `draftIds`, a message recorded the drafts it named as noticed, so the agent's catch-up notice left them out;
  - with `coalescingSubject` beside its `eventId`, a message made a restore count that coalesced occurrence as already delivered.

  The first time a server sends one of these keys, the host logs the server and the key, once for each server and key, without the value. Every other key a server sends is stored as before.
