- Awareness marks are one-shot. Switching branches, undo/redo and restarts no
  longer add or remove marks; previously a mark followed the branch, removed
  when the source branch became active and re-added when the recovery branch
  did. Each request is written ahead of its dispatch, and a dispatch is
  admitted from the journal as it is at that moment. A request that went out
  and got no answer stays `unknown` in its operation's history and in every
  receipt's unresolved count, even after a later attempt is confirmed; an
  operation's status is its latest answer. An operation is not sent again
  after three unconfirmed attempts (refused, or never answered and so
  possibly landed, one left on the wire when the host stopped included), or
  after a refusal no retry can change (a message, channel or emoji that is
  gone, missing access, a message that takes no more reactions), and a
  delivery pass that gives up on operations raises one
  `discord-awareness-delivery` ops alert, as does a start whose
  reconciliation gives up on any. A JSON-RPC error answer, which may come
  after the server acted, is recorded `unknown`. Between opposite requests
  for one reaction, the later authorization wins, whenever each was
  created. A batch whose surgery was interrupted before its branch switch
  was recorded is held at startup until an operator releases it. An
  interrupted suppression's redactions are resumed whenever its branch is
  active at startup, independent of what happened to its marks.
- A journal record that certifies a body change (a marks activation, a
  completed suppression, a retired batch, or the batch a `hide` or turn
  `undo` records after its change) is now written only after that change is
  synced to the store. Previously a crash could keep marks active for a
  rollback the store had lost. If writing a `hide` or turn `undo` batch
  fails, its receipt follows what the journal then holds: a batch that
  reached the store is activated, retired or reported `unresolved`, never
  reported `not-scheduled` while it could still be delivered. A write the
  store took but this process can't read back (Chronicle's periodic sync
  failing inside an append) leaves the journal refusing every read and write
  until the store is reopened, and such a receipt says `unresolved`: the next
  start reads that record with the rest.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL data
  plane waited at startup, at reconnect, at a tools list change and after each
  surgery until every queued mark had been attempted, which at Discord's pace
  could leave the resident deaf for minutes. Delivery now runs in the
  background. A route that is not connected keeps its work queued until it
  connects, and a delivery failure raises an ops alert instead of recycling
  connections. A journal that cannot be read still stops startup, because it
  also carries the suppression-resume record that protects the agent's
  context.
