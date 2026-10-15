- A workspace materialize with `force` and `applyDeletions` no longer removes
  a pipe, socket or device found at a path the workspace deleted, nor a
  followed symlink that leads to a directory or to anything else that isn't a
  regular file. Like a write, which already refused such a path, the unlink
  now acts only on a regular file, or on a followed symlink to one (removing
  the link itself), forced or not. Where the workspace's deletion of such a
  path is refused, forced or not, the refusal says that no push unlinks it,
  and to ask whoever runs the host if it should go. Before, the refusal for a
  pipe, socket or device offered a forced materialize to delete it. As before,
  the unlink checks the entry as close to the unlink as Node allows, so an
  entry swapped in at that very moment is still removed.
  - **For operators:** to clear such an entry, which a forced materialize used
    to remove, remove it by hand with `unlink <path>`: it removes that one
    entry, never what a link leads to, and refuses a directory. (`rm -r` on a
    link to a directory written with a trailing slash acts on the directory
    it leads to.)
