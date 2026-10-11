- Compiles that are never sent are now dry runs (context-manager's
  `SelectOptions.dryRun`): `previewActivation`, which undo, rollback and
  hiding messages also run for their "last visible" line; the API's
  `message.list` and agent context commands; and a conversation fork's seed
  (the template's compile and the new namespace's emptiness check). A
  committing compile persists fold resolutions and can queue compression
  work, and with context-manager's thinking binding
  (anima-research/context-manager#160) it commits stamps and joins the
  branch's compiles awaiting acceptance, where one never sent can cost a live
  stream's later replies their thinking. A dry run does none of that, and it
  leaves the agent's consumed watermark and a prepared budget change alone,
  as `previewActivation` already promised; a preview at the live window used
  to settle a converging budget change. Context-manager 0.13's adaptive
  select still writes its in-memory bookkeeping on a dry run until the next
  compile: the compile estimate a usage report is calibrated against, the
  arming of that calibration sample, and its transition and render
  bookkeeping. `ActivationRequestOptions` gains `dryRun`.
- When the fold plan doesn't fit the budget, a dry run returns the window as
  rendered, larger than the budget, where a committing compile threw.
  Refusals at other stages still throw, and context-manager 0.13 hands no
  over-budget signal back. So at a budget too small for the context, a
  preview and the API's agent context command now return instead of failing,
  and a fork whose template doesn't fit the budget its seed is compiled at
  (context-manager's default) is now seeded instead of failing to spawn.
- A conversation fork's seed no longer copies the template's `thinking` and
  `redacted_thinking` blocks, and leaves out a message with no content left.
  A fork inherits the template's conversation, not its reasoning. A signed
  block was minted under the template's prefix, which the fork's system
  prompt, tools and scoped injections don't promise to match, so on an
  account that enforces thinking binding the fork's first request could be
  refused (inferred from probes of other requests, not observed on a fork).
  Unsigned reasoning, from text-only providers or XML mode, goes by the same
  rule.
