- `semantic_search` builds a summary hit's snippet from the local summary, as it
  already does for message hits, instead of taking the service's copy: up to the
  summary's first 400 UTF-16 units, with "…" when it's cut. A service that
  stores only vectors and ids, and returns no text, now gives summary hits a
  snippet instead of an empty one. Since a branch made from an earlier point, as
  an undo makes one, can mint a summary id another branch already used, a
  summary hit no longer shows that other branch's summary, and one whose summary
  is empty on this branch is dropped and counted in `droppedStale`.
