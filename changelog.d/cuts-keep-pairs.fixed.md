- **Text cut to a fixed length for an agent to read no longer ends or
  starts on half a surrogate pair.** An emoji or another character outside
  the Basic Multilingual Plane that fell across such a cut left half of its
  pair, which the agent read as a replacement character (U+FFFD) or, in a
  result's data, as an escape such as `\ud83d`. These cuts now leave out a
  pair they would halve:
  - the event gate's quote of a debounced event's content (200 units);
  - a utility's one-liner in `utils list` (160 units);
  - a failed spill's reason in a truncated tool result (200 units);
  - each recent error in health's `snapshot` (400 units);
  - the last 2000 units of a dead background script's output, in the wake
    that tells the agent it died;
  - a thrown error's text, as a subconscious tool's failed result reports
    it. It's now cut at 500 characters counted as code points, as
    `boundedErrorMessage` cuts, and its "(N characters)" counts code points.
    A text within 500 characters now comes back whole, even past 500 UTF-16
    units. So do the framework's and the MCPL checkpoint manager's other
    quotes made through `thrownText`, such as a refusal when stored state
    can't be read.
