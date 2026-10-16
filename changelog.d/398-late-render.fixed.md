- **A late `push/render` answer is now recorded** (#398).
  - **A `push/render` answered after its timeout**, once the batch's
    fallback was in place, left no record. It's now a `mcpl:coalescing`
    `late-render` with `discarded: true`, naming the server, the render's
    `featureSet` and `key`, and the `eventId` that links it to the batch's
    `render-failed`. While a data plane was paused, the late answer was also
    held and took a slot of that plane's bound; now it isn't held.
  - **`McplServerConnection` no longer emits `orphaned-render-response`.** A
    late `push/render` answer is an `orphaned-response`, with
    `method: 'push/render'`, `featureSet`, `key` and `eventId`.
