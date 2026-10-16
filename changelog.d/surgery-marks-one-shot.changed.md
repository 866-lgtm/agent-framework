- Awareness marks are one-shot. Switching branches, undo/redo and restarts no
  longer request marks or removals of their own; previously a mark followed
  the branch, removed
  when the source branch became active and re-added when the recovery branch
  did. Each request is written ahead of its dispatch, and a dispatch is
  admitted from the journal as it is at that moment. A request that went out
  and got no answer stays `unknown` in its operation's history and in every
  receipt's unresolved count, even after a later attempt is confirmed; an
  operation's status is its latest answer. An operation is not sent again
  after three unconfirmed attempts (Discord refused it, or no answer came
  and so it may have landed, one left on the wire when the host stopped
  included; an attempt refused before it left the host doesn't count), or
  after a refusal no retry can change (a message, channel or emoji that is
  gone, missing access, a message that takes no more reactions), and a
  delivery pass that gives up on operations raises one
  `discord-awareness-delivery` ops alert, as does a start whose
  reconciliation gives up on any. A JSON-RPC error answer, which may come
  after the server acted, is recorded `unknown`. Between opposite requests
  for one reaction, the later authorization wins, whenever each was
  created.
- A start never activates a surgery's marks. A batch an interrupted
  surgery left (prepared, or held by a pre-release build of this journal) is
  retired at the next start, none of its marks sent, with a
  `discord-awareness-not-scheduled` ops alert that names the surgery, its
  agent and its branches, and the redo that applies the marks: the surgery
  again from its source, which still has every message it removed, onto a
  new branch name. An interrupted suppression's removals are still
  finished, at the first start on its branch, and its batch is retired
  then. A suppression whose removals are pending and whose branch doesn't
  exist (its surgery ended before it created it, or it was deleted) is
  given up with a `discord-awareness-suppression-unfinished` alert, since
  its removals apply only there. Until a suppression is finished or given
  up, a rollback, a suppression, an offline recovery or the API's
  `branch.create` refuses its branch name, cancelled or not, since a start
  on a branch made under it would apply those removals there. While the
  journal can't be read, every new branch name is refused, since none can
  be checked; after a write that failed inside the store, a restart, which
  reopens the store, ends that. A `hide` or turn `undo` records its batch
  and the batch's activation as one journal entry, so a crash never leaves
  it half recorded.
- A journal record that certifies a body change (a marks activation, a
  completed suppression, a retired batch, or the batch a `hide` or turn
  `undo` records after its change) is now written only after that change is
  synced to the store. Previously a crash could keep marks active for a
  rollback the store had lost. If writing a `hide` or turn `undo` batch
  fails, its receipt follows what the journal then holds: a batch that
  reached the store is `queued`, one that may have is `unresolved`, and
  neither is reported `not-scheduled` while it could still be delivered. A
  write the store took but this process can't read back (Chronicle's
  periodic sync failing inside an append) leaves the journal refusing every
  read and write until the store is reopened, and such a receipt says
  `unresolved`: the next start reads that record with the rest.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL data
  plane waited at startup, at reconnect, at a tools list change and after each
  surgery until every queued mark had been attempted, which at Discord's pace
  could leave the resident deaf for minutes. Delivery now runs in the
  background. A route that is not connected keeps its work queued until it
  connects, and a delivery failure raises an ops alert instead of recycling
  connections. A journal that cannot be read still stops startup, as does a
  pre-journal ledger that can't be imported: either can hold a suppression
  whose removals a start must finish before the agent's context is served,
  and a start that can't read it can't tell.
