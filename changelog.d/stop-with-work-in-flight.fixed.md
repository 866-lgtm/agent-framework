- **Late tool results, and MCPL requests and notifications, at `stop()` no
  longer end in an unhandled rejection.** `stop()` closes the process queue
  before it closes MCPL connections, and nothing caught the "Queue is
  closed" that this meant for late arrivals. Test files that stop a
  framework while a tool still runs, such as `conversation-routing`, failed
  at file level with it.
  - A tool's result that arrives after `stop()` is logged and dropped: the
    queue that would carry it to its stream is closed, and the tool has
    already run. Before, its push threw, the throw was reported as the
    tool's own failure, and that failure's push threw again, unhandled.
  - tune-out's results now go through the same `pushEvent` as every other
    tool's, so they also emit `process:received`, and a rejection of its
    handler is answered with a failed result, as other tools' dispatch
    failures are, instead of being left unhandled.
  - The drop's log line names the tool and whether it succeeded, which is
    what decides whether anything needs reconciling (the resident may run
    the tool again). For this, the framework's tool results carry the tool's
    name (`ToolResultEvent.toolName`, optional).
  - A server's `push/event`, `channels/incoming`, `channels/register`,
    `channels/changed`, `inference/request` or `host/command` that arrives
    once the host is stopping is refused before its handler runs, with a
    JSON-RPC error (`-32000`, "the host is stopping", the code the push
    coalescer already gives a stopping host). It is never answered
    "accepted", no inference starts, and no host command runs.
  - A handler that throws is answered with an error too: while the host
    stops, `-32000` with the handler's own message after "the host stopped
    while handling this request"; on a live host, `-32603` with its message.
    The message is bounded, and any thrown value is printed safely. Part of
    the request may already have been admitted. A notification is logged.
  - **For operators:** such a handler fault used to be an unhandled
    rejection, which ends a Node process by default, so a supervisor would
    have restarted the host. Now the host stays up and logs the failure.
  - A request is answered at most once. A second answer, such as a
    handler's late one after its failure was answered, is refused and
    logged. An answer that throws, such as a result the connection can't
    serialize, doesn't count, so the request still gets the error answer.
  - Any other event pushed to a stopped framework still throws to its
    caller.
