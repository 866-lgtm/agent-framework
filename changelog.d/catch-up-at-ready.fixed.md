- A workspace mount's catch-up pass, which takes in what changed on disk
  while the session was down, now runs once the mount's watcher is ready. So
  a change made after the pass has looked at a file reaches the watcher.
  Started beside the watcher's first scan, the pass could finish with a file
  before the watcher watched it, and a change made between the two reached
  neither until a sync or a later catch-up pass took it in. A watcher that
  isn't ready within 30 s has the pass started then, and its ready, if it
  comes, runs the pass again. A re-attached watcher's pass waits for its
  ready the same way. The status's `initialSyncDone` turns true when the
  first whole-mount pass ends, usually the catch-up pass, so it now turns
  true later, by as long as the watcher's first scan takes, up to 30 s.
