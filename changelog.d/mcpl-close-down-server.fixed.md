- A `reconnect: true` MCPL server that the framework closes for good now
  leaves the registry even when it's down at the time, so a later connect of
  its id isn't refused as already registered. The framework closes a server
  for good when a runtime `connectMcplServer` or `restartMcplServer` fails
  its Discord awareness accounting or its policy registration, and when the
  server refuses the host's policy with the `"close"` fallback. The registry
  dropped a closed server only when its connection reported the close, and a
  connection that's down between retries reports none. So the stub a failed
  first connect leaves stayed registered after such a close, and a later
  `connectMcplServer` of its id failed as already registered until
  `disconnectMcplServer` or `restartMcplServer` dropped it. A close that
  fails still keeps the server registered, so a later disconnect, restart or
  shutdown can close it again, and the failed connect now logs it.
- A runtime `connectMcplServer` or `restartMcplServer` that fails after
  pausing the other MCPL servers' data planes no longer leaves their data
  held. The connect paused them behind a gate that it settled only when it
  succeeded, so their pushes, incoming messages and inference requests
  waited until some other gate completed.
  - When its Discord awareness accounting fails, it now fails that gate, as
    a failed reconnect, tools-list reconciliation,
    `syncDiscordAwarenessMarkers()` or `resume()` already does: each running
    server is recycled, and its data flows once its reconnect's accounting
    succeeds. A server without `reconnect: true` is closed for good there,
    as on those paths. While the host is stopping, the gate is released
    instead.
  - When its policy registration throws after accounting succeeded, it now
    closes the new server for good, where it stayed connected and half
    registered, and completes the gate, so the running servers' data flows
    on with no recycle.
