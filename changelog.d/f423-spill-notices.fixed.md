- A cut tool result's spill notice now survives every reader's per-message
  cut while the turn, each result at its least, fits the bound, unless a
  mount name past about seventy characters makes the notice longer than its
  room, or results' notices differ in length (by call ids of different
  lengths) and the turn passes the bound by that difference. Under a turn's
  share of the bound, a result is at its least whole where it's no longer
  than what its cut would store in its place, and otherwise as its notice
  alone. 0.24.1 said the notice survived until a turn's notices alone filled
  the bound, which wasn't true for a notice longer than its share: results
  stored within their shares could leave it no room, and a result just past
  its share was stored as a notice longer than the result. Now, in a turn
  stored by its share, such a result is stored whole, and save_recent_image
  counts the image slots it holds. A turn whose results fit the bound
  together is stored as before, unless a save_recent_image in it had it
  stored by its share only because such a result's slots differed: it's now
  stored as each result would be alone, as other turns that fit are.
- A spill notice's paging advice in a turn stored by its share is sized to
  the inline cap that a later read of the file comes back under, alone in
  its own turn, rather than to the share. Under a share below the notice's
  room, the advice was to read one character at a time.
