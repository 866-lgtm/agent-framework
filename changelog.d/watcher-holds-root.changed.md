- **Operators:** on Linux, a workspace mount's watcher holds the mount's root
  directory open while it watches it, so a directory made in a removed
  root's place can't take the removed one's inode number and look like it.
  So `umount` of the file system under a watched root fails with "target is
  busy" while the host watches it; `umount -l` still detaches it. And a root
  removed and made again is found at the watcher's next root poll
  (`watchRootPollMs`, 2 s by default) rather than at once.
