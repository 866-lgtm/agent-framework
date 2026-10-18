- **Operators:** on Linux, a workspace mount's watcher holds the mount's root
  directory open while it watches it, so it can tell whether that directory
  has been removed whatever has since been made at its path. So `umount` of
  the file system under a watched root fails with "target is busy" while the
  host watches it; `umount -l` still detaches it. And a root removed, or
  replaced by a rename over it, is found at the watcher's next root poll
  (`watchRootPollMs`, 2 s by default) rather than at once.
