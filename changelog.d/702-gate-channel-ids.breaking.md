- **Hosts and residents with gate policies that name a channel:** a policy's
  `match.channel` in the registered form, such as
  `discord:<guild>:<channel>` or `discord:<guild>:*`, now matches every
  event in that channel, its push events included (#702). A message in an
  open channel arrives through `channels/incoming` with the registered id,
  but every other event arrives as a push: an addressed message in a closed
  channel, a message in a channel the adapter subscribes to without opening,
  and in any channel a reaction, an edit, a delete, a voice report or a
  missed-message catch-up. A push's own channel id is the adapter's raw one
  (a bare Discord snowflake), or none, as on a voice report, so a
  registered-form pattern missed all of those, and each fell through to a
  later policy. The pattern is now tested against the event's own id and,
  when that misses, against the registered id the framework resolves for the
  push: its origin's `mcplChannelId`, or, for a Discord origin without one,
  its guild and channel (`discord:dm:<channel>` when it names no guild, as a
  DM's doesn't). A push whose origin names its channel neither way, from
  another adapter, still matches by its raw id alone.

  **Who notices:** a config whose channel policy, written in the registered
  form, sits ahead of the rule that used to take those push events.
  - **Quieter:** a `defer` channel policy stops them waking the resident,
    and a `passive_sample` one wakes on its every-Nth only (with
    `passthrough`, the others go on to later rules). A `debounce` one
    batches and delays them, and a `rate_limit` one can deny them.
  - **Louder:** an `always` channel policy ahead of a `defer` rule wakes on
    every reaction, edit and voice report in that channel.
  - **A later policy can lose events:** no pattern matches fewer events than
    before, but a later policy, such as one naming the channel's raw id, no
    longer receives the pushes an earlier registered-form policy now
    matches. The shadow lint compares patterns as written, so it doesn't
    report this.
  - **Counting, in any config:** every `rate_limit` and `passive_sample`
    with `keyBy: "channelId"`, whatever its policy matches, counts a
    channel's push events with its messages, under its registered id. A
    push was counted under its raw id, or in the shared bucket when it
    carried none, as a voice report doesn't. So a channel's messages and
    pushes now share one bucket or counter, and voice reports in different
    channels no longer share one.
  - **A host that builds its own `EventGate` with `resolveRouteChannel`:**
    its resolver, which routed batched wakes, now also decides which
    channel policies a push meets and how `keyBy: "channelId"` counts it.
    `EventGate`'s default resolver gives no push a registered id, so with
    it a push matches and counts by its own id, as before.

  **Migration:** to keep a registered-form channel policy to the channel's
  messages, closed channels' addressed ones included, add `tagsAny:
  ["chat:ambient", "chat:addressed"]` to it. Those are Discord's message
  tags, and its reactions, edits, deletes, voice reports and catch-ups carry
  neither; another adapter's markers may carry `chat:addressed`. To keep it
  to exactly what it caught before, add `scope: ["mcpl:channel-incoming"]`,
  since a registered-form pattern matched no push before. Neither changes
  how `keyBy: "channelId"` now counts. A pattern written as `*<raw id>`,
  which matched both paths before, matches as it did, and now also matches a
  push that names its channel only by `mcplChannelId`, such as a voice
  report.

  **Unchanged:** which policy an event meets stays as it was in a config
  whose rules for the push events it receives (addressed messages,
  reactions, voice reports and the rest) come before its channel policies
  and aren't `passthrough`, and for a channel policy scoped to
  `mcpl:channel-incoming`. Counting with `keyBy: "channelId"` changes even
  there, as above.
