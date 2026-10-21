- The workspace's `delete`, `edit` and `edit_many`, and its `readBinary`,
  which the framework's `read_image` reads through, no longer answer "File
  not found" for a path the workspace doesn't hold when the check of disk
  before them decided nothing, because the selected branch kept changing
  while it ran. Each now says that disk couldn't be checked, with that
  reason, and to try again. Before, disk might hold the file, and the same
  call made again found it (#552).
