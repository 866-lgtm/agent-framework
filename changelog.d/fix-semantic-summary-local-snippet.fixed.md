- `semantic_search` builds a summary hit's snippet from the local summary, as it
  already does for message hits, instead of taking the service's copy. A
  service that stores only vectors and ids, and returns no text, now gives
  summary hits a snippet instead of an empty one.
