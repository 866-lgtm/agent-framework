- Workspace `sync` says what it didn't look at (#276). A sync now counts,
  under `passedOver`, what each mount's scan skipped by design and reported
  nowhere else, by reason. Today that's the entries its ignore list covers
  that hold nothing the workspace tracks; an ignored directory counts once,
  and one that hides a tracked path is listed under `incomplete` instead. A
  walk cut short, by the file cap or a directory that changed while it was
  listed, is listed under `incomplete`, and counts only what it kept. So a
  `totalSynced` of 0, with a `totalConflicts` of 0 and nothing under
  `passedOver`, `incomplete` or `skipped`, means the sync looked everywhere
  and nothing had changed; changed files it couldn't take in are listed
  under `skipped`. A path the ignore list covers
  is synced when named, a directory's contents included, and the result
  lists it under `ignored`: a sync without a path passes over it, so nothing
  else keeps it current. A symlink isn't counted: the pass reports each one
  by path, taken through the link when it's a file on a mount that follows
  symlinks, and otherwise listed under `skipped`.
