- **Agents, and whoever writes their prompts, on a mount that holds a
  directory named like the mount itself:** a `workspace--glob` pattern, or a
  `workspace--grep` `glob` filter, whose first segment is that mount's name
  is now read mount-prefixed in that mount, from its root, and no longer as
  written there. So a pattern written relative to the mount, such as
  `work/z/*.ts` for the file the tools show as `work/work/z/a.ts`, no longer
  finds that file. Where nothing else matches, the agent gets an answer
  with no matches (`glob`'s `"matches": []`, `grep`'s `"results": []`), not
  an error.
  - **Migration:** write the path as the tools show it: `work/work/z/*.ts`
    finds `work/work/z/a.ts`.
  - **Unchanged:** in every other mount, and for a pattern whose first
    segment names no mount, the pattern is still matched relative to the
    mount (or to `path`).
