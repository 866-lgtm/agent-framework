- The notice that a channel opened without the agent asking (an open its
  own send or reply caused, or a subscription-policy admission) names
  `channel_close` only to an agent that can call it there for every channel
  it names. A conversation fork can close only its home channel, and an
  agent's `allowedTools` can leave `channel_close` out. Before, such an agent
  was told to use `channel_close`, and couldn't call it, or its call was
  refused. Where an agent's
  own send opened a channel it can't close, the primary is now told by name
  too, if it can close it.
- When a conversation fork or an ephemeral run is released without reading a
  channel notice it could act on (a channel its own send opened, or a
  channel its reply couldn't open that is selected for opening), the primary
  is told by name in its place, as for a reply whose delivery failed. Before,
  the notice stayed unread in the released agent's window.
