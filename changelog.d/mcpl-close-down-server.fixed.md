- A `reconnect: true` MCPL server that the framework closes for good now
  leaves the registry even when it's down at the time, so a later connect of
  its id isn't refused as already registered. The framework closes a server
  for good when a runtime `connectMcplServer` or `restartMcplServer` fails
  its Discord awareness accounting, and when the server refuses the host's
  policy with the `"close"` fallback. The registry dropped a closed server
  only when its connection reported the close, and a connection that's down
  between retries reports none. So the stub a failed first connect leaves
  stayed registered after such a close, and a later `connectMcplServer` of
  its id failed as already registered until `disconnectMcplServer` or
  `restartMcplServer` dropped it.
