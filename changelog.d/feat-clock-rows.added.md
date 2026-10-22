- **Clock rows** (`AgentConfig.clock`, off by default): with
  `clock: { intervalMinutes: 10 }` (or `intervalSeconds`, and `precision:
  'minutes' | 'seconds'`), an agent's window takes a `Clock: 10:50
  Europe/Berlin (UTC+02:00)` row whenever a boundary of that interval on its
  local wall clock (from local midnight, in the framework's `timeZone`) has
  passed since its last clock: before an incoming event, at a fresh turn's
  start (a silent heartbeat tick included), and mid-turn after a tool
  round's results, where it also joins the live stream as an injected
  message (not on a stream that can't carry injected messages, such as
  membrane's XML prefill path: there the next event or turn start writes
  it). Only the latest boundary is written, and a window that holds no
  clock row yet, a conversation fork's seeded one included, takes one at its
  next write. A clock reads the boundary's time where that tick would have
  stood, else the time it is written (after a tool round or a reply that
  spanned the boundary), so it never reads earlier than a row before it; it
  shows the weekday and date when the day has changed since the last clock.
  Clock rows are `system: true`, `kind: 'clock'`, with `metadata.clock: {
  at, onBoundary, zone }`; they wake no one, move no routing locus and clear
  no send suppression. None is written while the host is quiesced, or into
  the residents' shared slot while another of its readers has a turn alive.
  Residents share one window, so each reads every resident's clock rows, one
  with no `clock` included, and the finest interval among them sets how
  often they all read one; the subconscious takes none of its own. On some
  models a clock after a tool's results drops the loop's earlier thinking
  from the request, as any message heard while acting does there, at most
  once an interval. An invalid `clock` setting makes `AgentFramework.create`
  throw, naming the agent. `resolveClockConfig` (the validation `create`
  runs, for a host checking a recipe up front), `formatClockText`,
  `latestBoundary`, `CLOCK_ROW_KIND` and the `ClockConfig` / `ClockStamp` /
  `ResolvedClockConfig` types are exported.
