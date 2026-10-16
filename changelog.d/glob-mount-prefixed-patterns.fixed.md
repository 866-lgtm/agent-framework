- `workspace--glob` finds files from a mount-prefixed pattern, such as
  `notes/diary/2026-10-13.md` or `project/src/**/*.ts`, as every other
  workspace path is written and as its own results are returned. The pattern
  was matched only against paths relative to the mount (or to `path`), so a
  mount-prefixed one answered "no matches" for files that were there. When a
  pattern's first segment names a mount, its rest is now also matched within
  that mount; patterns that name no mount match exactly as before, including
  a relative one whose first directory happens to share a mount's name.
  `workspace--grep`'s `glob` filter takes a mount-prefixed pattern the same
  way.
