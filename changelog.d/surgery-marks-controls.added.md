- Operator controls for awareness marks, described in the README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks):
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the journal's batches and retract
    requests.
  - `cancelDiscordAwareness(batch | retractRequest)` stops all further sends
    and retries of a batch's marks, or of a retract's removals, and never
    removes or undoes anything.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each message's configured MCPL route, for every
    selected message, whatever history says.
  - `checkDiscordAwarenessBranchName(name)` refuses (`invalid`) a name for a
    new branch that a suppression with pending removals names as its
    target, since a start on a branch with that name would apply them there.

  The same controls are the `host/command` `marks` verb (`action: list |
  cancel | retract`, `target`). Each control that changes the journal is
  recorded in the operator log, and refuses once `stop()` has begun, like
  every operator entry point.
