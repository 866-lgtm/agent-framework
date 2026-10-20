- `semantic_search` finds what the resident sent through a send tool. The
  index took text blocks and private-prose tool arguments only, so a resident
  with `proseRouting: "disabled"`, which speaks only through send tools, had
  none of its own replies indexed. The message argument (`content`, or the
  `text` older `channel_publish` callers send) of `channel_publish`,
  `send_message`, `reply_message`, `send_dm` and `edit_message`, under any
  MCPL prefix, is now indexed as `[<tool>] …`, with or without
  `includePrivateTools`. Messages indexed before this change are not re-sent;
  drop the namespace to index them again.
