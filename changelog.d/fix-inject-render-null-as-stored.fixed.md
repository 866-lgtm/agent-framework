- A message that arrives during a turn's tool call, and that the strategy
  renders as `null`, is injected into the live stream as stored again. The
  memory strategy gives `null` for a message before its recent window (a
  batch bigger than that window), and for every message while a head
  window a topic change reset hasn't filled yet. 0.24.1 left such a message
  out of the live round and stored a `[not shown]` system line in its
  place. But the next compile sends it raw, in order, after the tool
  result, so the agent didn't hear it mid-turn, the line was false, and the
  next request differed from the live rounds anyway. The `[not shown]`
  line, and the log line naming what was left out, are gone. A clock row
  the render gives `null` goes in as stored too. A single message too big
  for the recent window, which the strategy stores in parts, still goes in
  as stored where the next request sends it differently.
