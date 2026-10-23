# Continuing until skip_reply (`autoContinue`)

`autoContinue` is a default-off per-agent setting. With it on, a turn the
model ends itself is followed by another turn straight away, instead of the
usual pause until the next event (a message, a heartbeat, a timer). The agent
keeps going until it says it's done: by calling `skip_reply`, or another tool
that ends the turn, such as `sleep`.

```json
"agent": { "autoContinue": true }                       // cap of 3
"agent": { "autoContinue": { "maxConsecutive": 5 } }    // 1 to 20
```

## Which turns continue

A turn continues when the model ended it (stop reason `end_turn` or
`stop_sequence`), whether its last response is prose or empty, unless:

- a tool ended it: `skip_reply`, `sleep`, any endTurn tool;
- its last prose envelope is a skip: `>>skip_reply` in explicit mode, or a
  `>>>skip_reply` in hybrid mode whose hold is still standing at the end;
- it asked for a ` !` continuation (`>>#ops !`), which runs instead, with no
  notice, and counts toward nothing;
- it was a silent heartbeat tick;
- it ended with a refusal, a `max_tokens` cut-off, or the stall guard's
  `no_progress` / `round_limit`;
- the agent is an ephemeral run (a subagent), or the framework is stopping.

## What the agent reads

As the next turn starts, a short system row joins the window, so it is the
newest thing the turn reads (after the last turn's `[delivered]` receipt,
outside explicit mode, whose envelopes acknowledge themselves and write no
receipt):

```
[continue] Your last turn ended without skip_reply, so another one starts now. To stop and wait for the next event, call skip_reply.
```

Near the cap the row also says how many continuations are left:

```
… Continuation 2 of 3 in a row: one more is left.
… This is the last continuation in a row (3 of 3): after this turn you wait for the next event either way.
```

An agent that can't call `skip_reply` is told to end with a `>>skip_reply`
(explicit) or `>>>skip_reply` (hybrid) envelope instead; in locus or disabled
mode without the tool, the row names no way to stop and the cap ends the run.

The row is written by the scheduler as it starts the turn that takes the
continuation's wake, never earlier, so it never claims a turn that doesn't
run: a wake the inference policy drops writes no row and gives back its
count, and a row that can't be stored starts no continuation. It is appended
before the turn compiles and never retracted, so the prompt-cache prefix
stays stable. It is deliberately short and
event-shaped: longer instruction blocks about output, sent as user-role
messages, have tripped provider classifiers.

## The next turn

The continuation's wake has source `framework` and reason `auto-continue`. In
locus and hybrid modes it carries the turn's locus as its channel, so the next
turn's plain prose lands where the last one's did rather than in the
process-global last-inbound channel.

A message that arrives meanwhile joins the same turn, as any batched wake
does, and then that turn is the message's: its channel outranks the
continuation's (ambient included, though the continuation's wake was queued
later), no `[continue]` row is written, and the run's count starts again.

## The cap

At most `maxConsecutive` continuations run in a row (default 3). The count
starts again when a turn starts with a cause of its own (anything but a
framework wake), and when a tool ends a turn. Each continued turn is a full
inference over the context (mostly cache reads), and in locus mode its prose
is published, so the cap bounds both the cost and the posts of an agent that
never skips.
