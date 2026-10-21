- `workspace--glob` finds files from a mount-prefixed pattern, such as
  `notes/diary/2026-10-13.md` or `project/src/**/*.ts`, as every other
  workspace path is written and as its own results are returned. The pattern
  was matched only against paths relative to the mount (or to `path`), so a
  mount-prefixed one answered "no matches" for files that were there. When a
  pattern's first segment names a mount, that mount now matches its rest from
  the mount's root, in place of the pattern as written. Every other mount
  still matches the pattern relative to the mount (or to `path`), so
  `notes/*.md` still finds `project/notes/todo.md` beside the `notes` mount's
  own files. In a mount holding a directory named like itself, a pattern
  written relative to the mount, such as `work/z/*.ts` for `work/work/z/a.ts`,
  now reads mount-prefixed and no longer finds that file; `work/work/z/*.ts`,
  as the tools show it, does.
  `workspace--grep`'s `glob` filter takes a mount-prefixed pattern the same
  way. In both, a `**/` at the start of a path segment now matches zero or
  more directories, as in other glob tools, so `project/src/**/*.ts` also finds `project/src/main.ts` and
  `**/*.md` also finds the `.md` files at a mount's root; it used to need at
  least one directory there.
