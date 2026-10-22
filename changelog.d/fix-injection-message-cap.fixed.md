- A message that arrives during a turn's tool call is injected into the
  live stream as the next compile would send it, where it was injected
  whole. The agent's strategy renders the boundary's messages as the newest
  of its window (context-manager's `renderAsNewest`): cut by the
  per-message cap, a sharded body joined, and its images as the image
  limits leave them, counted newest-first across the batch. So the next
  turn's request matches what the live rounds carried, and its prompt cache
  holds, where a message over `maxMessageTokens`, or with more images than
  `maxLiveImages`, made the next request differ there. A message that
  arrives later can still take an injected one past an image limit, as it
  can any message. A message the next compile won't send among its newest,
  such as one in a batch bigger than the memory strategy's recent window,
  isn't injected, and a log line names it. In its place a stored system
  line after the batch, `[not shown]`, tells the agent who sent it, its
  size in characters and images, and the `history--extract` call that reads
  it, or its id where the agent isn't shown that tool. It names the agent
  it's for, since residents sharing a slot read it too. Where that boundary
  marks what it stored as read, the message counts as read with it, so a
  coalesced render's wake to read it is dropped and a release doesn't pass
  it to the primary. A strategy without `renderAsNewest`, or a render that
  throws, which is logged, gets the message as stored, as before.
